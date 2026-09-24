// HTTP server (remote mode): exposes the MCP over Streamable HTTP behind OAuth.
//
// The MCP endpoint lives at the ROOT ("/"): Claude (remote connector) sends both
// the OAuth flow and the MCP protocol from the domain root. mcpAuthRouter mounts
// the OAuth metadata and /authorize /token /register on their own paths.

import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { GoogleOAuthProvider } from './auth/google-oauth-provider.js';
import { getDefaultBitrixOAuthProvider } from './bitrix24/oauth-provider.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Minimal page for the "your account is not authorized" case.
function forbiddenPage(email) {
  const who = email ? ` (${escapeHtml(email)})` : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Access denied</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">
<h1>Access denied</h1>
<p>Your Google account${who} is not on the allowlist of this MCP server.</p>
<p>Ask the administrator to add your email to <code>B24_ALLOWED_EMAILS</code>.</p>
</body></html>`;
}

export function bitrixInstallationHandler(bitrixProvider) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (String(req.body?.event || '').toUpperCase() !== 'ONAPPINSTALL') {
        return res.status(400).type('text').send('Unsupported event.');
      }
      await bitrixProvider.acceptInstallation(req.body?.auth);
      return res.status(200).type('text').send('OK');
    } catch (err) {
      process.stderr.write(`[bitrix24] OAuth installation callback rejected: ${err.message}\n`);
      return res.status(403).type('text').send('Forbidden.');
    }
  };
}


// `registerTools` is passed in (not imported) to avoid an index ↔ http-server
// import cycle: index.js is a top-level-await module, and a static import back
// into it would deadlock the async module graph.
export async function startHttpServer(config, registerTools) {
  const provider = new GoogleOAuthProvider(config);
  const baseUrl = new URL(config.publicUrl);
  const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource', baseUrl).href;

  const app = express();
  // Single reverse proxy (host nginx) in front: trust its X-Forwarded-* headers so
  // the SDK's rate limiter keys on the real client IP instead of lumping everyone
  // together under 127.0.0.1.
  app.set('trust proxy', 1);
  app.use(
    cors({
      origin: true,
      exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
    })
  );
  // High limit: tools like b24_apply_config send large configuration JSON.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb', parameterLimit: 100 }));

  // Public healthcheck (no auth): used by the Docker healthcheck.
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Bitrix24 local API-only application callback. This is intentionally public:
  // Bitrix24 calls it during installation before any MCP/Google OAuth session
  // exists. The first request is verified with `profile` against the configured
  // portal; subsequent requests must carry the stored application_token.
  if (config.bitrixOAuthInstallEnabled) {
    const bitrixProvider = getDefaultBitrixOAuthProvider();
    app.post('/bitrix/oauth/install', bitrixInstallationHandler(bitrixProvider));
  }

  // OAuth endpoints acting as an Authorization Server towards Claude:
  // /.well-known/*, /authorize, /token, /register.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: baseUrl,
      baseUrl,
      resourceServerUrl: baseUrl,
      scopesSupported: ['openid', 'email'],
      resourceName: 'Bitrix24 MCP',
    })
  );

  // Return from Google: validate the email and forward to Claude (or 403).
  app.get('/auth/callback', async (req, res) => {
    try {
      const result = await provider.handleGoogleCallback(req.query);
      if (result.error === 'forbidden') {
        return res.status(403).type('html').send(forbiddenPage(result.email));
      }
      return res.redirect(result.redirectUrl);
    } catch (err) {
      return res.status(400).type('html').send(
        `<h1>Authentication error</h1><p>${escapeHtml(err.message)}</p>`
      );
    }
  });

  // MCP endpoint at the root, protected by Bearer. Stateless pattern: a fresh
  // McpServer and transport per request, closed when the response ends.
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

  app.post('/', bearer, async (req, res) => {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerTools(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: `Internal server error: ${err.message}` },
          id: null,
        });
      }
    }
  });

  // In stateless mode there is no server→client SSE stream nor session to delete.
  const methodNotAllowed = (_req, res) =>
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  app.get('/', bearer, methodNotAllowed);
  app.delete('/', bearer, methodNotAllowed);

  await new Promise((resolve) => {
    app.listen(config.port, config.host, resolve);
  });
  process.stderr.write(
    `[bitrix24] HTTP MCP listening on ${config.host}:${config.port} | Google OAuth | ` +
      `${provider.allowed.size} email(s) in allowlist\n`
  );
}

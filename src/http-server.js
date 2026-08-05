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

// Minimal page for the "your account is not authorized" case.
function forbiddenPage(email) {
  const who = email ? ` (${email})` : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Access denied</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">
<h1>Access denied</h1>
<p>Your Google account${who} is not on the allowlist of this MCP server.</p>
<p>Ask the administrator to add your email to <code>B24_ALLOWED_EMAILS</code>.</p>
</body></html>`;
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

  // Public healthcheck (no auth): used by the Docker healthcheck.
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
      return res.status(400).type('html').send(`<h1>Authentication error</h1><p>${err.message}</p>`);
    }
  });

  // MCP endpoint at the root, protected by Bearer. Stateless pattern: a fresh
  // McpServer and transport per request, closed when the response ends.
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

  app.post('/', bearer, async (req, res) => {
    const server = new McpServer({ name: 'bitrix24-config', version: '2.0.0' });
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

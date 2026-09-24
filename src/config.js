// Server configuration: loads and validates environment variables.
//
// Two transports (B24_TRANSPORT):
//   - stdio (default) — local run next to Claude Desktop, no auth;
//   - http — remote server with Google OAuth and an email allowlist.

import { loadBitrixOAuthConfig } from './bitrix24/oauth-provider.js';

function parseEmails(raw) {
  return (raw || '')
    .replace(/;/g, ',')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function envInt(name, def) {
  const raw = (process.env[name] || '').trim();
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? def : n;
}

function envBool(name) {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] || '').trim().toLowerCase());
}

export function loadConfig() {
  const transport = (process.env.B24_TRANSPORT || 'stdio').trim().toLowerCase() || 'stdio';
  if (!['stdio', 'http'].includes(transport)) {
    throw new Error('B24_TRANSPORT must be either stdio or http.');
  }

  const bitrixAuthMode = (process.env.B24_BITRIX_AUTH_MODE || 'webhook').trim().toLowerCase() || 'webhook';
  if (!['webhook', 'oauth'].includes(bitrixAuthMode)) {
    throw new Error('B24_BITRIX_AUTH_MODE must be either webhook or oauth.');
  }

  const config = {
    transport,
    bitrixAuthMode,
    bitrixOAuthInstallEnabled: envBool('B24_BITRIX_OAUTH_INSTALL_ENABLED'),
    host: (process.env.B24_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: envInt('B24_PORT', 8001),
    // No trailing slash: the redirect URI is built as `${publicUrl}/auth/callback`.
    publicUrl: (process.env.B24_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    googleClientId: (process.env.B24_GOOGLE_CLIENT_ID || '').trim(),
    googleClientSecret: (process.env.B24_GOOGLE_CLIENT_SECRET || '').trim(),
    allowedEmails: parseEmails(process.env.B24_ALLOWED_EMAILS),
    defaultWebhook: (process.env.B24_DEFAULT_WEBHOOK || '').trim(),
    // Optional separate webhook for Knowledge Base 2.0 (note.* methods): it needs
    // the `note` scope, which the shared webhook usually lacks. Empty → the
    // b24_kb2_* tools fall back to the default webhook.
    noteWebhook: (process.env.B24_NOTE_WEBHOOK || '').trim(),
    // Optional path where the OAuth provider persists clients/tokens so they
    // survive a restart. Empty → in-memory only (tokens lost on restart).
    oauthStorePath: (process.env.B24_OAUTH_STORE_PATH || '').trim(),
  };

  if (config.transport === 'http') {
    const missing = [];
    if (!config.publicUrl) missing.push('B24_PUBLIC_URL');
    if (!config.googleClientId) missing.push('B24_GOOGLE_CLIENT_ID');
    if (!config.googleClientSecret) missing.push('B24_GOOGLE_CLIENT_SECRET');
    if (missing.length) {
      throw new Error(`B24_TRANSPORT=http requires these variables: ${missing.join(', ')}`);
    }
    let publicUrl;
    try {
      publicUrl = new URL(config.publicUrl);
    } catch {
      throw new Error('B24_PUBLIC_URL must be a valid HTTPS URL.');
    }
    if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
      throw new Error('B24_PUBLIC_URL must use HTTPS without credentials, query parameters, or fragments.');
    }
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error('B24_PORT must be an integer between 1 and 65535.');
    }
    // OAuth proves the user signed in with Google, but does NOT restrict WHO. The
    // allowlist is the only access barrier; without it the server would let in any
    // Google user. That's why it is mandatory in http mode.
    if (config.allowedEmails.length === 0) {
      throw new Error(
        'B24_ALLOWED_EMAILS is empty: in http mode the email allowlist is mandatory, ' +
          'otherwise the server would let in any Google user.'
      );
    }
  }

  if (config.bitrixAuthMode === 'oauth' || config.bitrixOAuthInstallEnabled) {
    loadBitrixOAuthConfig();
    config.bitrixInstallCallbackAvailable = config.transport === 'http';
    if (config.bitrixOAuthInstallEnabled && config.transport !== 'http') {
      throw new Error('B24_BITRIX_OAUTH_INSTALL_ENABLED requires B24_TRANSPORT=http.');
    }
  }

  return config;
}

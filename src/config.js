// Server configuration: loads and validates environment variables.
//
// Two transports (B24_TRANSPORT):
//   - stdio (default) — local run next to Claude Desktop, no auth;
//   - http — remote server with Google OAuth and an email allowlist.

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

export function loadConfig() {
  const transport = (process.env.B24_TRANSPORT || 'stdio').trim().toLowerCase() || 'stdio';

  const config = {
    transport,
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

  return config;
}

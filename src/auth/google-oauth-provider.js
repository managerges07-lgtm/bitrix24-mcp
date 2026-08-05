// OAuth provider for the MCP server, with Google as the upstream identity.
//
// The MCP SDK requires the server to act as an Authorization Server towards the
// client (Claude): Dynamic Client Registration, /authorize, /token and metadata.
// Google does NOT support DCR, so we cannot simply proxy to Google. Instead this
// provider IS the AS for Claude and, under the hood, uses Google to authenticate
// the real user (same approach as FastMCP's GoogleProvider).
//
// Flow: authorize() redirects to Google → /auth/callback exchanges the code,
// extracts the email and checks it against the allowlist → only then do we issue
// OUR authorization code → /token exchanges it for an access + refresh token.
//
// In-memory storage: enough for a single-process VPS. After a container restart
// tokens are lost and the user signs in again (Claude re-discovers and
// re-registers automatically).

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import axios from 'axios';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

// TTLs (seconds). Short access + long refresh: if an access token is stolen, its
// usable window is small; the session stays alive via the (rotated) refresh token.
const PENDING_TTL = 10 * 60; // in-flight flow to Google
const CODE_TTL = 5 * 60; // authorization code (single-use)
const ACCESS_TTL = 60 * 60; // access token
const REFRESH_TTL = 30 * 24 * 60 * 60; // refresh token
// After rotation the spent refresh token stays valid for this long and replays the
// same result: Claude fires several refreshes in parallel, and strict single-use
// would fail all but one of them and kill the session.
const REFRESH_GRACE = 60;
const SWEEP_INTERVAL_MS = 60 * 1000;

const now = () => Math.floor(Date.now() / 1000);

// Decode a JWT payload (Google id_token) WITHOUT verifying the signature. This is
// safe in this flow: the id_token arrives over the server↔Google back-channel
// (TLS) as a direct response to OUR code exchange (OIDC code flow, §3.1.3.7), not
// from the client. We still validate the claims (iss/aud/exp) below.
function decodeJwtPayload(jwt) {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('malformed id_token');
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

class InMemoryClientsStore {
  constructor(onChange) {
    this.clients = new Map();
    this._onChange = onChange || (() => {});
  }

  getClient(clientId) {
    return this.clients.get(clientId);
  }

  // DCR (RFC 7591): Claude registers at the start of the flow. We generate the
  // client_id; being a public PKCE client, we issue no client_secret.
  registerClient(client) {
    const clientId = randomUUID();
    const full = {
      ...client,
      client_id: clientId,
      client_id_issued_at: now(),
    };
    this.clients.set(clientId, full);
    this._onChange();
    return full;
  }
}

export class GoogleOAuthProvider {
  /** @param {{publicUrl:string, googleClientId:string, googleClientSecret:string, allowedEmails:string[]}} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.allowed = new Set(cfg.allowedEmails.map((e) => e.trim().toLowerCase()));
    this.redirectUri = `${cfg.publicUrl}/auth/callback`;
    // Optional on-disk persistence so registered clients and tokens survive a
    // container restart (otherwise every restart forces users to re-login).
    this.storePath = cfg.oauthStorePath || '';

    this.clientsStore = new InMemoryClientsStore(() => this._persist());
    this._pending = new Map(); // google state  -> { client, params, expiresAt }
    this._codes = new Map(); // our auth code  -> { client, params, email, expiresAt }
    this._tokens = new Map(); // access_token   -> { clientId, scopes, email, expiresAt }
    this._refresh = new Map(); // refresh_token  -> { clientId, scopes, email, expiresAt }

    // Rehydrate clients/tokens persisted before the last restart (if any).
    this._load();

    // Periodic sweep: keeps the Maps from growing unbounded with abandoned flows
    // or expired tokens. unref() so it doesn't keep the process alive.
    this._sweepTimer = setInterval(() => this._sweep(), SWEEP_INTERVAL_MS);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }

  _sweep() {
    const t = now();
    let changed = false;
    for (const map of [this._pending, this._codes, this._tokens, this._refresh]) {
      for (const [key, val] of map) {
        if (val.expiresAt <= t) {
          map.delete(key);
          if (map === this._tokens || map === this._refresh) changed = true;
        }
      }
    }
    if (changed) this._persist();
  }

  // Rehydrate persisted state on startup. Expired tokens are dropped on load.
  // Failures are non-fatal — the server just continues with an empty store.
  _load() {
    if (!this.storePath || !existsSync(this.storePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.storePath, 'utf8'));
      const t = now();
      for (const [id, client] of data.clients || []) this.clientsStore.clients.set(id, client);
      for (const [key, val] of data.tokens || []) if (val.expiresAt > t) this._tokens.set(key, val);
      for (const [key, val] of data.refresh || []) if (val.expiresAt > t) this._refresh.set(key, val);
    } catch (err) {
      process.stderr.write(`[bitrix24] oauth store load failed: ${err.message}\n`);
    }
  }

  // Atomically persist clients + tokens (temp file + rename, mode 0600). The
  // short-lived in-flight state (_pending/_codes) is intentionally not persisted.
  _persist() {
    if (!this.storePath) return;
    try {
      const data = {
        clients: [...this.clientsStore.clients.entries()],
        tokens: [...this._tokens.entries()],
        refresh: [...this._refresh.entries()],
      };
      const tmp = `${this.storePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, this.storePath);
    } catch (err) {
      process.stderr.write(`[bitrix24] oauth store persist failed: ${err.message}\n`);
    }
  }

  // Validate the claims of Google's id_token and return the verified email.
  _emailFromIdToken(idToken) {
    const claims = decodeJwtPayload(idToken);
    if (!GOOGLE_ISSUERS.has(claims.iss)) throw new Error('id_token: unexpected issuer');
    if (claims.aud !== this.cfg.googleClientId) throw new Error('id_token: aud mismatch');
    if (typeof claims.exp !== 'number' || claims.exp <= now()) throw new Error('id_token expired');
    // email_verified may come as a boolean or the string "true".
    if (claims.email_verified !== true && claims.email_verified !== 'true') {
      throw new Error('id_token: email not verified');
    }
    return (claims.email || '').trim().toLowerCase();
  }

  // Issue access + refresh tokens for an already authenticated, authorized user.
  _issueTokens(clientId, scopes, email) {
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    this._tokens.set(accessToken, { clientId, scopes, email, expiresAt: now() + ACCESS_TTL });
    this._refresh.set(refreshToken, { clientId, scopes, email, expiresAt: now() + REFRESH_TTL });
    this._persist();
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TTL,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  // /authorize step: instead of showing our own login, we redirect to Google.
  // `params` is already parsed by the SDK: { redirectUri, codeChallenge, scopes?, state?, resource? }.
  async authorize(client, params, res) {
    const googleState = randomUUID();
    this._pending.set(googleState, { client, params, expiresAt: now() + PENDING_TTL });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', this.cfg.googleClientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', googleState);
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
    res.redirect(url.toString());
  }

  // Called by the GET /auth/callback route. Returns { redirectUrl } to forward
  // back to Claude, or { error, email } if the email is not authorized.
  async handleGoogleCallback(query) {
    const { code, state, error: googleError } = query;
    if (googleError) throw new Error(`Google returned an error: ${googleError}`);
    if (!code || !state) throw new Error('missing code/state params in callback');

    const pending = this._pending.get(state);
    if (!pending || pending.expiresAt <= now()) throw new Error('unknown or expired state');
    this._pending.delete(state);

    // Exchange code → Google tokens (the id_token carries the email).
    const body = new URLSearchParams({
      code,
      client_id: this.cfg.googleClientId,
      client_secret: this.cfg.googleClientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });
    const resp = await axios.post(GOOGLE_TOKEN_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    const idToken = resp.data?.id_token;
    if (!idToken) throw new Error('Google did not return an id_token');

    const email = this._emailFromIdToken(idToken);

    // Allowlist: the only barrier of who may use the shared webhook.
    if (!email || !this.allowed.has(email)) {
      return { error: 'forbidden', email };
    }

    // Authorized email → issue OUR authorization code, bound to the original PKCE
    // challenge and to the client that started the flow.
    const { client, params } = pending;
    const ourCode = randomUUID();
    this._codes.set(ourCode, { client, params, email, expiresAt: now() + CODE_TTL });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', ourCode);
    if (params.state !== undefined) redirectUrl.searchParams.set('state', params.state);
    return { redirectUrl: redirectUrl.toString() };
  }

  // The SDK uses this to validate the PKCE verifier against the stored challenge.
  async challengeForAuthorizationCode(client, authorizationCode) {
    const data = this._codes.get(authorizationCode);
    if (!data || data.expiresAt <= now() || data.client.client_id !== client.client_id) {
      throw new InvalidGrantError('invalid authorization code');
    }
    return data.params.codeChallenge;
  }

  // /token step (authorization_code grant): exchange our single-use code.
  async exchangeAuthorizationCode(client, authorizationCode /*, codeVerifier, redirectUri, resource */) {
    const data = this._codes.get(authorizationCode);
    if (!data || data.expiresAt <= now() || data.client.client_id !== client.client_id) {
      throw new InvalidGrantError('invalid authorization code');
    }
    this._codes.delete(authorizationCode); // single-use
    return this._issueTokens(client.client_id, data.params.scopes || [], data.email);
  }

  // /token step (refresh_token grant): renew the session without re-login. We
  // rotate the refresh token (invalidate the old one) as a best practice, but keep
  // it replayable for REFRESH_GRACE seconds — see the constant.
  async exchangeRefreshToken(client, refreshToken /*, scopes, resource */) {
    const data = this._refresh.get(refreshToken);
    if (!data || data.expiresAt <= now() || data.clientId !== client.client_id) {
      throw new InvalidGrantError('invalid refresh token');
    }
    // If the email dropped off the allowlist, cut the session here.
    if (!this.allowed.has(data.email)) {
      this._refresh.delete(refreshToken);
      throw new InvalidGrantError('account no longer authorized');
    }
    // Already rotated moments ago (parallel refresh): replay the same tokens.
    if (data.rotatedTo) return data.rotatedTo;

    const tokens = this._issueTokens(client.client_id, data.scopes, data.email);
    // Rotation with a grace window: shorten the old token's life instead of
    // deleting it, so the sweep drops it once the window closes.
    data.rotatedTo = tokens;
    data.expiresAt = now() + REFRESH_GRACE;
    this._persist();
    return tokens;
  }

  // Invoked by requireBearerAuth on every MCP request. Returns AuthInfo or throws.
  // The error MUST be an InvalidTokenError: the SDK maps only that one to 401 +
  // WWW-Authenticate (any other error becomes a 500, and the client then treats a
  // simply expired token as a server outage and never refreshes).
  async verifyAccessToken(token) {
    const data = this._tokens.get(token);
    if (!data) throw new InvalidTokenError('invalid token');
    if (data.expiresAt <= now()) {
      this._tokens.delete(token);
      throw new InvalidTokenError('token expired');
    }
    // Defense in depth: if the email was removed from the allowlist, the token
    // stops working immediately (no need to wait for it to expire).
    if (!this.allowed.has(data.email)) {
      this._tokens.delete(token);
      throw new InvalidTokenError('account no longer authorized');
    }
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: data.expiresAt,
      extra: { email: data.email },
    };
  }
}

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import axios from 'axios';

const STORE_VERSION = 1;
const STORE_AAD = Buffer.from('bitrix24-mcp/oauth-store/v1', 'utf8');

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required when Bitrix24 OAuth is enabled.`);
  return normalized;
}

function normalizeHost(value) {
  const raw = required(value, 'B24_BITRIX_PORTAL_HOST').toLowerCase();
  if (/^[a-z0-9.-]+$/.test(raw) && !raw.includes('..')) return raw;
  throw new Error('B24_BITRIX_PORTAL_HOST must be a hostname without a scheme or path.');
}

function validateHttpsUrl(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    (url.port && url.port !== '443')
  ) {
    throw new Error(`${name} must use standard HTTPS without credentials, query, or fragment.`);
  }
  return url;
}

export function validateClientEndpoint(raw, expectedPortalHost) {
  const url = validateHttpsUrl(raw, 'Bitrix24 client_endpoint');
  if (url.hostname.toLowerCase() !== expectedPortalHost || url.pathname !== '/rest/') {
    throw new Error('Bitrix24 client_endpoint does not match the configured portal.');
  }
  return url.toString();
}

function decodeEncryptionKey(raw) {
  const encoded = required(raw, 'B24_BITRIX_TOKEN_ENCRYPTION_KEY');
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error('B24_BITRIX_TOKEN_ENCRYPTION_KEY must be an unpadded base64url value for 32 bytes.');
  }
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32) {
    throw new Error('B24_BITRIX_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return key;
}

function secretEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class EncryptedOAuthTokenStore {
  constructor(filePath, encryptionKey) {
    this.filePath = required(filePath, 'B24_BITRIX_TOKEN_STORE_PATH');
    this.key = Buffer.isBuffer(encryptionKey) ? encryptionKey : decodeEncryptionKey(encryptionKey);
    if (this.key.length !== 32) throw new Error('OAuth token-store encryption key must be 32 bytes.');
  }

  async load() {
    let envelope;
    try {
      envelope = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new Error(`Cannot read the Bitrix24 OAuth token store: ${err.message}`);
    }
    if (envelope?.version !== STORE_VERSION) {
      throw new Error('Unsupported Bitrix24 OAuth token-store version.');
    }
    try {
      const iv = Buffer.from(envelope.iv, 'base64url');
      const tag = Buffer.from(envelope.tag, 'base64url');
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(STORE_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new Error('Cannot decrypt or authenticate the Bitrix24 OAuth token store.');
    }
  }

  async save(payload) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(STORE_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    const envelope = {
      version: STORE_VERSION,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

export function loadBitrixOAuthConfig(env = process.env) {
  const portalHost = normalizeHost(env.B24_BITRIX_PORTAL_HOST);
  const tokenUrl = validateHttpsUrl(
    required(env.B24_BITRIX_OAUTH_TOKEN_URL, 'B24_BITRIX_OAUTH_TOKEN_URL'),
    'B24_BITRIX_OAUTH_TOKEN_URL'
  );
  if (tokenUrl.pathname !== '/oauth/token/') {
    throw new Error('B24_BITRIX_OAUTH_TOKEN_URL must end with /oauth/token/.');
  }
  return {
    portalHost,
    clientId: required(env.B24_BITRIX_CLIENT_ID, 'B24_BITRIX_CLIENT_ID'),
    clientSecret: required(env.B24_BITRIX_CLIENT_SECRET, 'B24_BITRIX_CLIENT_SECRET'),
    tokenUrl: tokenUrl.toString(),
    storePath: required(env.B24_BITRIX_TOKEN_STORE_PATH, 'B24_BITRIX_TOKEN_STORE_PATH'),
    encryptionKey: decodeEncryptionKey(env.B24_BITRIX_TOKEN_ENCRYPTION_KEY),
  };
}

export class BitrixOAuthProvider {
  constructor(config, { request = axios.request.bind(axios), store } = {}) {
    this.portalHost = normalizeHost(config.portalHost);
    this.clientId = required(config.clientId, 'Bitrix24 OAuth client ID');
    this.clientSecret = required(config.clientSecret, 'Bitrix24 OAuth client secret');
    this.tokenUrl = validateHttpsUrl(config.tokenUrl, 'Bitrix24 OAuth token URL').toString();
    this.store = store || new EncryptedOAuthTokenStore(config.storePath, config.encryptionKey);
    this.request = request;
    this.refreshPromise = null;
    this.writeQueue = Promise.resolve();
  }

  async getAccessContext() {
    const tokens = await this.store.load();
    if (!tokens) {
      throw new Error(
        'Bitrix24 OAuth is not installed. Configure the local API-only application to call /bitrix/oauth/install.'
      );
    }
    return {
      accessToken: required(tokens.accessToken, 'Stored Bitrix24 access token'),
      clientEndpoint: validateClientEndpoint(tokens.clientEndpoint, this.portalHost),
    };
  }

  async acceptInstallation(auth) {
    return this._exclusive(() => this._acceptInstallation(auth));
  }

  _exclusive(operation) {
    const next = this.writeQueue.then(operation);
    this.writeQueue = next.catch(() => {});
    return next;
  }

  async _acceptInstallation(auth) {
    const incoming = {
      accessToken: required(auth?.access_token, 'auth.access_token'),
      refreshToken: required(auth?.refresh_token, 'auth.refresh_token'),
      applicationToken: required(auth?.application_token, 'auth.application_token'),
      memberId: required(auth?.member_id, 'auth.member_id'),
      clientEndpoint: validateClientEndpoint(auth?.client_endpoint, this.portalHost),
      scope: required(auth?.scope, 'auth.scope'),
      expiresIn: Number(auth?.expires_in || 0),
      installedAt: new Date().toISOString(),
    };
    if (!Number.isFinite(incoming.expiresIn) || incoming.expiresIn <= 0) {
      throw new Error('auth.expires_in must be a positive number.');
    }

    const existing = await this.store.load();
    if (existing) {
      if (
        existing.memberId !== incoming.memberId ||
        !secretEqual(existing.applicationToken, incoming.applicationToken)
      ) {
        throw new Error('Bitrix24 installation identity does not match the existing OAuth store.');
      }
    }

    // Validate every installation delivery, not just the first one. This also
    // prevents an old callback replay from replacing a healthy rotated pair.
    incoming.userId = await this._verifyAccessToken(incoming.clientEndpoint, incoming.accessToken);
    if (existing) {
      const previousUser = existing.userId || await this._verifyAccessToken(existing.clientEndpoint, existing.accessToken);
      if (previousUser !== incoming.userId) throw new Error('Bitrix24 OAuth user identity mismatch.');
    }
    await this.store.save(incoming);
    return {
      portalHost: this.portalHost,
      memberId: incoming.memberId,
      scope: incoming.scope,
      userId: incoming.userId,
    };
  }

  async _verifyAccessToken(clientEndpoint, accessToken) {
    try {
      const response = await this.request({
        method: 'post',
        url: `${clientEndpoint}profile.json`,
        data: { auth: accessToken },
        timeout: 30000,
        maxRedirects: 0,
        proxy: false,
      });
      const userId = Number(response.data?.result?.ID);
      if (response.data?.error || !Number.isSafeInteger(userId) || userId <= 0) throw new Error('profile rejected');
      return userId;
    } catch {
      throw new Error('Bitrix24 rejected the installation access token.');
    }
  }

  async refreshAccessToken(rejectedAccessToken) {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this._exclusive(() => this._refreshAccessToken(rejectedAccessToken));
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async _refreshAccessToken(rejectedAccessToken) {
    const current = await this.store.load();
    if (!current) throw new Error('Bitrix24 OAuth token store is empty. Reinstall the local application.');

    if (rejectedAccessToken && current.accessToken !== rejectedAccessToken) {
      return this.getAccessContext();
    }

    let data;
    try {
      const response = await this.request({
        method: 'get',
        url: this.tokenUrl,
        params: {
          grant_type: 'refresh_token',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: required(current.refreshToken, 'Stored Bitrix24 refresh token'),
        },
        timeout: 30000,
        maxRedirects: 0,
        proxy: false,
      });
      data = response.data;
    } catch (err) {
      const code = err.response?.data?.error || 'request_failed';
      throw new Error(`Bitrix24 OAuth refresh failed [${code}]. Reinstall may be required.`);
    }
    if (data?.error || !data?.access_token || !data?.refresh_token) {
      const code = data?.error || 'invalid_response';
      throw new Error(`Bitrix24 OAuth refresh failed [${code}]. Reinstall may be required.`);
    }

    const updated = {
      ...current,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      clientEndpoint: validateClientEndpoint(
        data.client_endpoint || current.clientEndpoint,
        this.portalHost
      ),
      memberId: data.member_id || current.memberId,
      scope: data.scope || current.scope,
      expiresIn: Number(data.expires_in || current.expiresIn || 0),
      refreshedAt: new Date().toISOString(),
    };
    if (updated.memberId !== current.memberId) {
      throw new Error('Bitrix24 OAuth refresh returned a different portal identity.');
    }
    const userId = await this._verifyAccessToken(updated.clientEndpoint, updated.accessToken);
    if (current.userId && current.userId !== userId) throw new Error('Bitrix24 OAuth user identity mismatch.');
    updated.userId = userId;
    await this.store.save(updated);
    return {
      accessToken: updated.accessToken,
      clientEndpoint: updated.clientEndpoint,
    };
  }
}

let cachedProvider;
let cachedFingerprint;

export function getDefaultBitrixOAuthProvider() {
  const config = loadBitrixOAuthConfig();
  const fingerprint = JSON.stringify([
    config.portalHost,
    config.clientId,
    config.tokenUrl,
    config.storePath,
  ]);
  if (!cachedProvider || cachedFingerprint !== fingerprint) {
    cachedProvider = new BitrixOAuthProvider(config);
    cachedFingerprint = fingerprint;
  }
  return cachedProvider;
}

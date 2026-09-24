import axios from 'axios';
import { RateLimiter } from '../utils/rate-limiter.js';

const MAX_RETRIES = 3;

// REST v3 reports failures as { code, message, validation: [{ field, message }] }.
// `validation` says WHICH field was rejected — the most useful part when filling
// forms — so it is folded into the message. The parsed error is also attached as
// `err.b24` so callers can branch on the code (e.g. a missing scope).
function v3Error(error, data) {
  const isObject = error && typeof error === 'object';
  const code = isObject ? error.code : error;
  const message = (isObject ? error.message : data?.error_description) ?? 'unknown error';
  const validation = Array.isArray(error?.validation) ? error.validation : [];
  const details = validation.map(v => (v.field ? `${v.field}: ${v.message}` : v.message)).join('; ');

  const err = new Error(`Bitrix24 error [${code}]: ${message}${details ? ` (${details})` : ''}`);
  err.b24 = { code, message, validation };
  return err;
}

function classicError(data) {
  const err = new Error(`Bitrix24 error [${data.error}]: ${data.error_description || 'unknown error'}`);
  err.b24 = { code: data.error, message: data.error_description };
  return err;
}

function isExpiredToken(err) {
  const responseError = err.response?.data?.error;
  const responseCode = responseError && typeof responseError === 'object'
    ? responseError.code
    : responseError;
  return (err.b24?.code || responseCode) === 'expired_token';
}

function sanitizedTransportError(error) {
  const safeMessage = error?.response?.status
    ? `Bitrix24 HTTP request failed with status ${error.response.status}.`
    : `Bitrix24 network request failed [${error?.code || 'unknown'}].`;
  const clean = new Error(safeMessage);
  clean.code = error?.code;
  if (error?.response) {
    clean.response = {
      status: error.response.status,
      headers: error.response.headers,
      data: error.response.data,
    };
  }
  return clean;
}

export class Bitrix24Client {
  constructor(connection, { request = axios.post.bind(axios), minDelay = 500 } = {}) {
    if (typeof connection === 'string') {
      this.webhookUrl = connection.endsWith('/') ? connection : connection + '/';
      this.portal = this._extractPortal(connection);
      this.v3BaseUrl = this._buildV3Base(this.webhookUrl);
    } else if (connection?.type === 'oauth' && connection.provider) {
      this.oauthProvider = connection.provider;
      this.portal = connection.provider.portalHost;
    } else {
      throw new Error('Bitrix24 connection must be a webhook URL or an OAuth provider.');
    }
    this.limiter = new RateLimiter(minDelay);
    this.request = request;
  }

  _validateMethod(method) {
    if (typeof method !== 'string' || !/^[a-z][a-z0-9_.]*$/i.test(method) || method.includes('..')) {
      throw new Error('Bitrix24 REST method has an invalid format.');
    }
  }

  async _request(url, params, headers) {
    try {
      return await this.request(url, params, {
        timeout: 30000,
        maxRedirects: 0,
        proxy: false,
        ...(headers ? { headers } : {}),
      });
    } catch (err) {
      // Axios errors retain the full request URL. In webhook mode that path is
      // itself a credential, so never let config/request objects escape.
      throw sanitizedTransportError(err);
    }
  }

  async _retryDelay(err, attempt, method) {
    // Unknown methods (including batch) may write. Never replay them after an
    // ambiguous transport failure. Only an explicit read suffix is retryable.
    if (!/(?:\.(?:get|list|fields|info)|^(?:profile|user.current))$/i.test(method)) return false;
    if (err.response?.status === 429 && attempt < MAX_RETRIES) {
      const parsed = Number.parseInt(err.response.headers?.['retry-after'] || '2', 10);
      const seconds = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 30) : 2;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return true;
    }
    if (err.code === 'ECONNABORTED' && attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
      return true;
    }
    return false;
  }

  _extractPortal(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return 'unknown';
    }
  }

  // REST v3 methods (e.g. the mail.* family) live under a different base path:
  // classic is /rest/{user}/{token}/, v3 is /rest/api/{user}/{token}/. Derive the
  // v3 base from the configured webhook by inserting the `api` segment.
  _buildV3Base(url) {
    try {
      const u = new URL(url);
      u.pathname = u.pathname.replace(/^\/rest\//, '/rest/api/');
      return u.toString();
    } catch {
      return url.replace('/rest/', '/rest/api/');
    }
  }

  async call(method, params = {}) {
    this._validateMethod(method);
    let authRefreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      let context;
      try {
        context = this.oauthProvider ? await this.oauthProvider.getAccessContext() : null;
        const baseUrl = context?.clientEndpoint || this.webhookUrl;
        const requestParams = context ? { ...params, auth: context.accessToken } : params;
        const url = `${baseUrl}${method}.json`;
        const response = await this.limiter.schedule(() => this._request(url, requestParams));
        if (response.data.error) {
          throw classicError(response.data);
        }
        return response.data;
      } catch (err) {
        if (this.oauthProvider && !authRefreshed && isExpiredToken(err)) {
          await this.oauthProvider.refreshAccessToken(context?.accessToken);
          authRefreshed = true;
          continue;
        }
        if (await this._retryDelay(err, attempt, method)) continue;
        throw err;
      }
    }
  }

  // Calls a REST v3 method (no `.json` suffix, /rest/api/ base). v3 wraps errors
  // in an { code, message, validation } object instead of the classic
  // error/error_description string pair, and returns them with a 4xx/5xx status —
  // so the body has to be unwrapped in the catch branch as well.
  //
  // options.idempotencyKey sends the Idempotency-Key header: the portal keeps the
  // first answer for 24h, so a retried create returns it instead of making a
  // duplicate. Same rate limiting and retry policy as call().
  async callV3(method, params = {}, options = {}) {
    this._validateMethod(method);
    const { idempotencyKey } = options;
    let authRefreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      let context;
      try {
        context = this.oauthProvider ? await this.oauthProvider.getAccessContext() : null;
        const v3BaseUrl = context ? this._buildV3Base(context.clientEndpoint) : this.v3BaseUrl;
        const requestParams = context ? { ...params, auth: context.accessToken } : params;
        const url = `${v3BaseUrl}${method}`;
        const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined;
        const response = await this.limiter.schedule(() => this._request(url, requestParams, headers));
        if (response.data.error) throw v3Error(response.data.error, response.data);
        return response.data;
      } catch (err) {
        if (this.oauthProvider && !authRefreshed && isExpiredToken(err)) {
          await this.oauthProvider.refreshAccessToken(context?.accessToken);
          authRefreshed = true;
          continue;
        }
        if (await this._retryDelay(err, attempt, method)) continue;
        if (err.response?.data?.error) throw v3Error(err.response.data.error, err.response.data);
        throw err;
      }
    }
  }
}

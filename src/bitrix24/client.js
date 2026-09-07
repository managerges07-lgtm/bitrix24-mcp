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

export class Bitrix24Client {
  constructor(webhookUrl, { request = axios.post.bind(axios), minDelay = 500 } = {}) {
    this.webhookUrl = webhookUrl.endsWith('/') ? webhookUrl : webhookUrl + '/';
    this.limiter = new RateLimiter(minDelay);
    this.request = request;
    this.portal = this._extractPortal(webhookUrl);
    this.v3BaseUrl = this._buildV3Base(this.webhookUrl);
  }

  _validateMethod(method) {
    if (typeof method !== 'string' || !/^[a-z][a-z0-9_.]*$/i.test(method) || method.includes('..')) {
      throw new Error('Bitrix24 REST method has an invalid format.');
    }
  }

  _request(url, params, headers) {
    return this.request(url, params, {
      timeout: 30000,
      maxRedirects: 0,
      proxy: false,
      ...(headers ? { headers } : {}),
    });
  }

  async _retryDelay(err, attempt) {
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
    for (let attempt = 0; ; attempt += 1) {
      try {
        const url = `${this.webhookUrl}${method}.json`;
        const response = await this.limiter.schedule(() => this._request(url, params));
        if (response.data.error) {
          throw new Error(`Bitrix24 error [${response.data.error}]: ${response.data.error_description}`);
        }
        return response.data;
      } catch (err) {
        if (await this._retryDelay(err, attempt)) continue;
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
    for (let attempt = 0; ; attempt += 1) {
      try {
        const url = `${this.v3BaseUrl}${method}`;
        const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined;
        const response = await this.limiter.schedule(() => this._request(url, params, headers));
        if (response.data.error) throw v3Error(response.data.error, response.data);
        return response.data;
      } catch (err) {
        if (await this._retryDelay(err, attempt)) continue;
        if (err.response?.data?.error) throw v3Error(err.response.data.error, err.response.data);
        throw err;
      }
    }
  }
}

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
  constructor(webhookUrl) {
    this.webhookUrl = webhookUrl.endsWith('/') ? webhookUrl : webhookUrl + '/';
    this.limiter = new RateLimiter(500);
    this.portal = this._extractPortal(webhookUrl);
    this.v3BaseUrl = this._buildV3Base(this.webhookUrl);
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

  async call(method, params = {}, retries = 0) {
    return this.limiter.schedule(async () => {
      try {
        const url = `${this.webhookUrl}${method}.json`;
        const response = await axios.post(url, params, { timeout: 30000 });
        if (response.data.error) {
          throw new Error(`Bitrix24 error [${response.data.error}]: ${response.data.error_description}`);
        }
        return response.data;
      } catch (err) {
        if (err.response?.status === 429 && retries < MAX_RETRIES) {
          const retryAfter = parseInt(err.response.headers['retry-after'] || '2', 10);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          return this.call(method, params, retries + 1);
        }
        if (err.code === 'ECONNABORTED' && retries < MAX_RETRIES) {
          const backoff = Math.pow(2, retries) * 1000;
          await new Promise(r => setTimeout(r, backoff));
          return this.call(method, params, retries + 1);
        }
        throw err;
      }
    });
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
    const { idempotencyKey, retries = 0 } = options;
    return this.limiter.schedule(async () => {
      try {
        const url = `${this.v3BaseUrl}${method}`;
        const response = await axios.post(url, params, {
          timeout: 30000,
          ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
        });
        if (response.data.error) throw v3Error(response.data.error, response.data);
        return response.data;
      } catch (err) {
        if (err.response?.status === 429 && retries < MAX_RETRIES) {
          const retryAfter = parseInt(err.response.headers['retry-after'] || '2', 10);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          return this.callV3(method, params, { ...options, retries: retries + 1 });
        }
        if (err.code === 'ECONNABORTED' && retries < MAX_RETRIES) {
          const backoff = Math.pow(2, retries) * 1000;
          await new Promise(r => setTimeout(r, backoff));
          return this.callV3(method, params, { ...options, retries: retries + 1 });
        }
        if (err.response?.data?.error) throw v3Error(err.response.data.error, err.response.data);
        throw err;
      }
    });
  }
}

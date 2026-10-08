import test from 'node:test';
import assert from 'node:assert/strict';
import { Bitrix24Client } from '../src/bitrix24/client.js';
import { logToolError } from '../src/utils/tool-error-log.js';

const denied = 'BITRIX_REST_V3_EXCEPTION_ACCESSDENIEDEXCEPTION';

function fixture({ status = 401, code = denied, persistent = false, oauth = true } = {}) {
  let requests = 0;
  let refreshes = 0;
  let token = 'expired-fixture';
  const provider = {
    portalHost: 'example.invalid',
    getAccessContext: async () => ({ clientEndpoint: 'https://example.invalid/rest/', accessToken: token }),
    refreshAccessToken: async rejected => {
      assert.equal(rejected, token);
      refreshes++;
      token = 'fresh-fixture';
    },
  };
  const client = new Bitrix24Client(oauth ? { type: 'oauth', provider } : 'https://example.invalid/rest/1/fixture/', {
    minDelay: 0,
    request: async (url, params) => {
      requests++;
      if (persistent || requests === 1) {
        throw { response: { status, data: { error: { code, message: 'Access denied' } } } };
      }
      assert.equal(params.auth, 'fresh-fixture');
      return { data: { result: { items: [{ id: 169 }] } } };
    },
  });
  return { client, counts: () => ({ requests, refreshes }) };
}

test('REST v3 mailbox 401 access denied refreshes OAuth and retries once', async () => {
  const f = fixture();
  assert.equal((await f.client.callV3('mail.mailbox.list')).result.items[0].id, 169);
  assert.deepEqual(f.counts(), { requests: 2, refreshes: 1 });
});

test('persistent REST v3 authentication denial stops after one refresh', async () => {
  const f = fixture({ persistent: true });
  await assert.rejects(f.client.callV3('mail.mailbox.list'), e => e.b24.code === denied && e.httpStatus === 401);
  assert.deepEqual(f.counts(), { requests: 2, refreshes: 1 });
});

for (const options of [{ status: 403 }, { status: 500 }, { code: 'OTHER_ERROR' }, { oauth: false }]) {
  test(`unrelated failures do not refresh or retry: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await assert.rejects(f.client.callV3('mail.mailbox.list'));
    assert.deepEqual(f.counts(), { requests: 1, refreshes: 0 });
  });
}

test('tool error logs retain diagnostic codes without credentials or payloads', () => {
  const lines = [];
  logToolError('mailMailboxList', {
    message: 'secret-message',
    config: { url: 'https://secret.invalid/credential', headers: { Authorization: 'secret' } },
    response: { status: 401, data: { error: { code: denied, message: 'private-mailbox' }, auth: 'secret-token' } },
  }, line => lines.push(line));
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'mcp_tool_error', tool: 'mailMailboxList', code: denied, http_status: 401,
  });
  logToolError('mailMailboxList', { code: 'secret-token', message: 'private-body' }, line => lines.push(line));
  assert.equal(JSON.parse(lines[1]).code, 'unclassified');
  assert.doesNotMatch(lines.join(''), /secret|private/);
});

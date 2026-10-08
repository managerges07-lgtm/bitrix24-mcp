import test from 'node:test';
import assert from 'node:assert/strict';
import { Bitrix24Client } from '../src/bitrix24/client.js';
import { mailMessageSend, mailMessageSendSchema, mailMailboxSenders } from '../src/tools/mail.js';

const message = {
  from: 'sender@example.com', to: ['recipient@example.com'],
  subject: 'Тема', body: '  <p>Здравствуйте!</p>\n',
};

function mockCall(t, implementation) {
  const previous = { mode: process.env.B24_BITRIX_AUTH_MODE, webhook: process.env.B24_DEFAULT_WEBHOOK };
  process.env.B24_BITRIX_AUTH_MODE = 'webhook';
  process.env.B24_DEFAULT_WEBHOOK = 'https://example.invalid/rest/1/fixture/';
  t.after(() => {
    for (const [name, value] of Object.entries({ B24_BITRIX_AUTH_MODE: previous.mode, B24_DEFAULT_WEBHOOK: previous.webhook })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  return t.mock.method(Bitrix24Client.prototype, 'callV3', implementation);
}

test('send preserves body and passes only documented REST v3 fields', async t => {
  const payload = { ...message, cc: ['copy@example.com'], bcc: ['hidden@example.com'] };
  const call = mockCall(t, async (method, params) => {
    assert.equal(method, 'mail.message.send');
    assert.deepEqual(params, payload);
    return { result: { success: true, to: message.to } };
  });
  assert.deepEqual(await mailMessageSend(payload), { portal: 'example.invalid', success: true, to: message.to });
  assert.equal(call.mock.callCount(), 1);
});

test('send omits unspecified copies and accepts multiple recipients', async t => {
  const payload = { ...message, to: [...message.to, 'second@example.com'] };
  mockCall(t, async (_method, params) => {
    assert.deepEqual(params, payload);
    return { result: { success: true, to: payload.to } };
  });
  assert.deepEqual((await mailMessageSend(payload)).to, payload.to);
});

test('invalid inputs fail before contacting Bitrix24', async t => {
  const call = mockCall(t, async () => { throw new Error('Must not call'); });
  for (const fields of [
    { from: 'invalid' }, { from: 'sender@example.com\r\nBcc: bad@example.com' },
    { to: [] }, { to: ['invalid'] }, { cc: ['invalid'] }, { bcc: ['invalid'] },
    { subject: '' }, { subject: '   ' }, { subject: 'hello\nBcc: x' },
    { body: '' }, { body: '   ' }, { attachments: ['unsupported'] },
  ]) {
    await assert.rejects(mailMessageSend({ ...message, ...fields }));
  }
  for (const key of ['from', 'to', 'subject', 'body']) {
    const payload = { ...message };
    delete payload[key];
    assert.equal(mailMessageSendSchema.safeParse(payload).success, false);
  }
  assert.equal(call.mock.callCount(), 0);
});

test('false success is preserved, malformed responses never become success', async t => {
  mockCall(t, async () => ({ result: { success: false, to: [] } }));
  assert.equal((await mailMessageSend(message)).success, false);
});

test('missing send result reports unknown outcome', async t => {
  mockCall(t, async () => ({ result: {} }));
  await assert.rejects(mailMessageSend(message), /результат отправки неизвестен/);
});

test('API errors propagate without resending', async t => {
  const error = Object.assign(new Error('MESSAGE_SEND_FAILED'), { b24: { code: 'VALIDATION' } });
  const call = mockCall(t, async () => { throw error; });
  await assert.rejects(mailMessageSend(message), e => e === error);
  assert.equal(call.mock.callCount(), 1);
});

test('senders uses REST v3 pagination and returns items', async t => {
  const items = [{ email: 'sender@example.com', name: 'Sender', sender: 'sender@example.com' }];
  mockCall(t, async (method, params) => {
    assert.equal(method, 'mail.mailbox.senders');
    assert.deepEqual(params, { pagination: { page: 2, limit: 100, offset: 0 } });
    return { result: { items } };
  });
  assert.deepEqual(await mailMailboxSenders({ page: 2, limit: 100, offset: 0 }), {
    portal: 'example.invalid', count: 1, senders: items,
  });
  await assert.rejects(mailMailboxSenders({ limit: 101 }));
});

test('senders omits unspecified pagination', async t => {
  mockCall(t, async (_method, params) => {
    assert.deepEqual(params, {});
    return { result: { items: [] } };
  });
  assert.deepEqual((await mailMailboxSenders({})).senders, []);
});

for (const failure of [
  { code: 'ECONNABORTED' }, { code: 'ECONNRESET' },
  { response: { status: 429, data: {} } }, { response: { status: 500, data: {} } },
]) {
  test(`REST client never retries mail send after ${failure.code || failure.response.status}`, async () => {
    let requests = 0;
    const client = new Bitrix24Client('https://example.invalid/rest/1/fixture/', {
      minDelay: 0,
      request: async url => {
        assert.equal(url, 'https://example.invalid/rest/api/1/fixture/mail.message.send');
        requests++;
        throw failure;
      },
    });
    await assert.rejects(client.callV3('mail.message.send', message));
    assert.equal(requests, 1);
  });
}

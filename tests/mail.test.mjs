import test from 'node:test';
import assert from 'node:assert/strict';
import { Bitrix24Client } from '../src/bitrix24/client.js';
import { mailMessageSend, mailMessageSendSchema, mailMailboxSenders, mailMessageReply, mailMessageReplySchema } from '../src/tools/mail.js';

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

test('reply uses REST v3 reply with original message ID and explicit recipients', async t => {
  const call = mockCall(t, async (method, params) => {
    assert.equal(method, 'mail.message.reply');
    assert.deepEqual(params, { ...message, replyToMessageId: 123, cc: ['copy@example.com'], bcc: ['hidden@example.com'] });
    return { result: { success: true, to: message.to } };
  });
  assert.deepEqual(await mailMessageReply({ ...message, reply_to_message_id: 123, cc: ['copy@example.com'], bcc: ['hidden@example.com'] }),
    { portal: 'example.invalid', success: true, to: message.to });
  assert.equal(call.mock.callCount(), 1);
});

test('reply validates source ID and inherited send fields before any request', async t => {
  const call = mockCall(t, async () => { throw new Error('Must not call'); });
  for (const id of [undefined, null, 0, -1, 1.5, '123', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(mailMessageReply({ ...message, reply_to_message_id: id }));
  }
  for (const fields of [{ to: [] }, { from: 'invalid' }, { subject: '' }, { body: '' }, { cc: ['invalid'] }, { bcc: ['invalid'] }]) {
    await assert.rejects(mailMessageReply({ ...message, reply_to_message_id: 123, ...fields }));
  }
  assert.equal(mailMessageReplySchema.safeParse({ ...message, replyToMessageId: 123 }).success, false);
  assert.equal(call.mock.callCount(), 0);
});

test('reply preserves failure and rejects unknown outcome without resending', async t => {
  let response = { result: { success: false, to: [] } };
  const call = mockCall(t, async () => response);
  assert.equal((await mailMessageReply({ ...message, reply_to_message_id: 123 })).success, false);
  response = { result: {} };
  await assert.rejects(mailMessageReply({ ...message, reply_to_message_id: 123 }), /mail.message.reply.*результат отправки неизвестен/);
  assert.equal(call.mock.callCount(), 2);
});

for (const method of ['mail.message.send', 'mail.message.reply'])
for (const failure of [
  { code: 'ECONNABORTED' }, { code: 'ECONNRESET' },
  { response: { status: 429, data: {} } }, { response: { status: 500, data: {} } },
]) {
  test(`REST client never retries ${method} after ${failure.code || failure.response.status}`, async () => {
    let requests = 0;
    const client = new Bitrix24Client('https://example.invalid/rest/1/fixture/', {
      minDelay: 0,
      request: async url => {
        assert.equal(url, 'https://example.invalid/rest/api/1/fixture/' + method);
        requests++;
        throw failure;
      },
    });
    await assert.rejects(client.callV3(method, { ...message, ...(method.endsWith('.reply') ? { replyToMessageId: 123 } : {}) }));
    assert.equal(requests, 1);
  });
}

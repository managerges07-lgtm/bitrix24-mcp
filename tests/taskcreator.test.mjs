import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jwtVerify } from 'jose';
import { callTaskcreator, taskcreatorConfig, taskcreatorOperations, registerTaskcreatorTools } from '../src/tools/taskcreator.js';
import { Bitrix24Client } from '../src/bitrix24/client.js';
import { BitrixOAuthProvider } from '../src/bitrix24/oauth-provider.js';
import express from 'express';
import { bitrixInstallationHandler } from '../src/http-server.js';

test('installation accepts JSON and nested form auth using the production handler', async () => {
  const seen = [];
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true, parameterLimit: 100 }));
  app.post('/install', bitrixInstallationHandler({ acceptInstallation: async auth => {
    assert.equal(auth.access_token, 'fixture-access');
    seen.push(auth);
  } }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/install`;
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'ONAPPINSTALL', auth: { access_token: 'fixture-access' } }) })).status, 200);
    assert.equal((await fetch(url, { method: 'POST', body: new URLSearchParams({ event: 'ONAPPINSTALL', 'auth[access_token]': 'fixture-access' }) })).status, 200);
    assert.equal((await fetch(url, { method: 'POST', body: new URLSearchParams({ event: 'OTHER' }) })).status, 400);
    assert.equal(seen.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('enabled integration registers exactly the narrow tools', () => {
  const values = { B24_TASKCREATOR_ENABLED: 'true', B24_BITRIX_AUTH_MODE: 'oauth',
    B24_TASKCREATOR_BASE_URL: 'https://assistant.example.invalid', B24_TASKCREATOR_PRIVATE_KEY_FILE: '/key' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    const names = [];
    registerTaskcreatorTools({ tool: (name, description, fields) => {
      names.push(name);
      assert.ok(fields.deal_id);
    } }, fn => fn);
    assert.equal(names.length, 12);
    assert.ok(names.includes('b24_taskcreator_delete'));
    assert.ok(!names.some(name => name.includes('reconciliation')));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('TaskCreator configuration fails closed', () => {
  assert.equal(taskcreatorConfig({}), null);
  assert.throws(() => taskcreatorConfig({ B24_TASKCREATOR_ENABLED: 'true' }), /OAuth/);
  for (const url of ['http://example.invalid', 'https://example.invalid/path', 'https://u:p@example.invalid', 'https://example.invalid/?token=x']) {
    assert.throws(() => taskcreatorConfig({ B24_TASKCREATOR_ENABLED: 'true', B24_BITRIX_AUTH_MODE: 'oauth', B24_TASKCREATOR_BASE_URL: url, B24_TASKCREATOR_PRIVATE_KEY_FILE: '/key' }));
  }
});

test('all tools use signed bounded requests, fixed paths and matching bodies', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskcreator-test-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyFile = path.join(directory, 'key.pem');
    await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const config = { baseUrl: 'https://assistant.example.invalid', keyFile };
    const args = {
      schema: {}, list: { include_deleted: true }, get: { type_key: 'review' },
      validate: { type_key: 'review', definition: { schema_version: 2 } },
      create_draft: { definition: { schema_version: 2 } },
      save_draft: { type_key: 'review', expected_revision: 1, definition: { schema_version: 2 } },
      publish: { type_key: 'review', expected_revision: 1, change_note: 'publish', confirm: true },
      rollback: { type_key: 'review', expected_revision: 1, version: 1, confirm: true },
      delete: { type_key: 'review', expected_revision: 1, expected_published_version: null, change_note: 'retire', confirm: true },
      context: {}, preview: { task_type: 'review' },
      create: { task_type: 'review', work_intent_token: 'work', confirmation_token: 'confirmation', confirm: true },
    };
    for (const name of Object.keys(taskcreatorOperations)) {
      let requests = 0;
      const result = await callTaskcreator(name, { deal_id: 42, ...args[name] }, { config, request: async req => {
        requests++;
        const { payload } = await jwtVerify(req.headers.Authorization.slice(7), publicKey, { issuer: 'bitrix24-mcp', audience: 'ges-assistant-taskcreator' });
        assert.equal(payload.scope, `taskcreator:${name}`);
        assert.equal(payload.deal_id, 42);
        assert.equal(payload.exp - payload.iat, 60);
        assert.equal(req.url, config.baseUrl + payload.path);
        assert.equal(req.method, payload.method);
        assert.equal(req.maxRedirects, 0);
        assert.equal(req.proxy, false);
        if (req.data) {
          assert.equal(req.data.deal_id, undefined);
          assert.equal(req.data.confirm, undefined);
        }
        if (name === 'validate' || name === 'create_draft') assert.deepEqual(req.data, args[name].definition);
        if (name === 'list') assert.deepEqual(req.params, { include_deleted: true });
        return { data: { ok: true } };
      } });
      assert.deepEqual(result, { ok: true });
      assert.equal(requests, 1);
    }
    await assert.rejects(callTaskcreator('delete', { deal_id: 42, ...args.delete, confirm: false }, { config }), /true/);
    let calls = 0;
    await assert.rejects(callTaskcreator('create', { deal_id: 42, ...args.create }, { config, request: async () => {
      calls++;
      throw { code: 'ECONNABORTED', config: { token: 'do-not-expose' } };
    } }), error => !error.message.includes('do-not-expose') && /unknown/.test(error.message));
    assert.equal(calls, 1);
    await assert.rejects(callTaskcreator('get', { deal_id: 42, type_key: '../other' }, { config }));
    await assert.rejects(callTaskcreator('get', { deal_id: 42, type_key: 'review', user_id: 999 }, { config }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('write timeout never retries in REST v1 or v3', async () => {
  for (const version of ['call', 'callV3']) {
    let calls = 0;
    const client = new Bitrix24Client({ type: 'oauth', provider: {
      portalHost: 'example.invalid', getAccessContext: async () => ({ clientEndpoint: 'https://example.invalid/rest/', accessToken: 'fixture' }),
    } }, { minDelay: 0, request: async () => { calls++; throw { code: 'ECONNABORTED' }; } });
    await assert.rejects(client[version]('tasks.task.add', {}));
    assert.equal(calls, 1);
  }
});

test('OAuth persists user identity and rejects changes on callback and refresh', async () => {
  let stored;
  let refreshUser = 7;
  let refreshCalls = 0;
  const store = { load: async () => structuredClone(stored), save: async value => { stored = structuredClone(value); } };
  const provider = new BitrixOAuthProvider({ portalHost: 'example.invalid', clientId: 'fixture', clientSecret: 'fixture', tokenUrl: 'https://oauth.example.invalid/oauth/token/' }, {
    store, request: async req => {
      if (req.url.endsWith('profile.json')) return { data: { result: { ID: req.data.auth === 'other-user' ? 8 : refreshUser } } };
      refreshCalls++;
      return { data: { access_token: 'refreshed', refresh_token: 'rotated', member_id: 'member' } };
    },
  });
  const auth = { access_token: 'initial', refresh_token: 'refresh', application_token: 'app', member_id: 'member', scope: 'crm', expires_in: 3600, client_endpoint: 'https://example.invalid/rest/' };
  await provider.acceptInstallation(auth);
  assert.equal(stored.userId, 7);
  await assert.rejects(provider.acceptInstallation({ ...auth, access_token: 'other-user' }), /identity mismatch/);
  assert.equal(stored.accessToken, 'initial');
  await Promise.all([provider.refreshAccessToken('initial'), provider.refreshAccessToken('initial')]);
  assert.equal(refreshCalls, 1);
  refreshUser = 8;
  await assert.rejects(provider.refreshAccessToken('refreshed'), /identity mismatch/);
  assert.equal(stored.userId, 7);
});

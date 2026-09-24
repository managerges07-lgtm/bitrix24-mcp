#!/usr/bin/env node
// Read-only business smoke. OAuth refresh may update the local credential store.
import { Bitrix24Client } from '../src/bitrix24/client.js';
import { getDefaultBitrixOAuthProvider } from '../src/bitrix24/oauth-provider.js';
import { callTaskcreator } from '../src/tools/taskcreator.js';

try {
  const deal_id = Number(process.argv[2]);
  if (!Number.isSafeInteger(deal_id) || deal_id <= 0) throw new Error('Pass one positive technical deal ID.');
  const client = new Bitrix24Client({ type: 'oauth', provider: getDefaultBitrixOAuthProvider() });
  const profile = (await client.call('profile')).result;
  if (profile?.ADMIN !== true && profile?.ADMIN !== 'Y') throw new Error('Technical account must be a Bitrix administrator.');
  const context = await callTaskcreator('context', { deal_id });
  if (context.created_by !== Number(profile.ID)) throw new Error('MCP and Assistant technical identities differ.');
  const schema = await callTaskcreator('schema', { deal_id });
  const catalog = await callTaskcreator('list', { deal_id });
  if (!schema.properties || !Array.isArray(catalog.types)) throw new Error('Unexpected TaskCreator response.');
  process.stdout.write(JSON.stringify({ ok: true, user_id: Number(profile.ID), deal_id,
    published_types: context.task_types.length, management_types: catalog.types.length }) + '\n');
} catch (error) {
  process.stderr.write(`TaskCreator read-only smoke failed: ${error.message}\n`);
  process.exitCode = 1;
}

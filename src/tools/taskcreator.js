// Narrow Assistant client: fixed origin, per-operation JWT, no automatic retries.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

const deal = { deal_id: z.number().int().positive().safe() };
const key = { type_key: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/) };
const revision = { expected_revision: z.number().int().nonnegative() };
const note = { change_note: z.string().trim().min(1).max(1000) };
const definition = { definition: z.record(z.unknown()) };
const confirmed = { confirm: z.literal(true).describe('Only after an explicit user instruction for this operation.') };
const values = z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]));
const input = { task_type: key.type_key, custom_values: values.default({}) };
const intent = z.string().min(1).max(4096);
const typePath = p => `/task-types/manage/${p.type_key}`;

export const taskcreatorOperations = {
  schema: ['GET', () => '/task-types/schema', {}, 'Get JSON schema for TaskCreator definitions.'],
  list: ['GET', () => '/task-types/manage', { include_deleted: z.boolean().default(false) }, 'List TaskCreator templates; optionally include deleted history.'],
  get: ['GET', typePath, key, 'Read template, revision, publication and audit, including deleted history.'],
  validate: ['POST', p => `${typePath(p)}/validate`, { ...key, ...definition }, 'Validate a template without saving.'],
  create_draft: ['POST', () => '/task-types/manage', definition, 'Create a TaskCreator draft; does not publish or create a task.'],
  save_draft: ['PUT', p => `${typePath(p)}/draft`, { ...key, ...revision, ...definition }, 'Save a draft using the last read revision.'],
  publish: ['POST', p => `${typePath(p)}/publish`, { ...key, ...revision, ...note, ...confirmed }, 'Publish only on explicit user instruction; first show the template changes.'],
  rollback: ['POST', p => `${typePath(p)}/rollback`, { ...key, ...revision, version: z.number().int().positive(), ...confirmed }, 'Create a draft from a historical version; publication is a separate operation.'],
  delete: ['DELETE', typePath, { ...key, ...revision, expected_published_version: z.number().int().positive().nullable(), ...note, ...confirmed }, 'Delete a TaskCreator template from the active catalog, retaining history and tasks. Requires explicit user instruction.'],
  context: ['GET', () => '/deal-tasks-v2/context', {}, 'Get published task types and current inputs for a deal.'],
  preview: ['POST', () => '/deal-tasks-v2/preview', { ...input, work_intent_token: intent.optional(), duplicate_acknowledged: z.boolean().default(false) }, 'Prepare a task preview; show it to the user before create. Never acknowledge duplicates without user instruction.'],
  create: ['POST', () => '/deal-tasks-v2/create', { ...input, work_intent_token: intent, confirmation_token: intent, ...confirmed }, 'Create exactly the confirmed preview. Do not retry automatically after a timeout; retain intent tokens for recovery.'],
};

export function taskcreatorConfig(env = process.env) {
  const enabled = /^(1|true|yes|on)$/i.test(env.B24_TASKCREATOR_ENABLED || '');
  if (!enabled) return null;
  if (env.B24_BITRIX_AUTH_MODE !== 'oauth') throw new Error('TaskCreator requires Bitrix OAuth mode.');
  let base;
  try { base = new URL(env.B24_TASKCREATOR_BASE_URL); } catch { throw new Error('Invalid TaskCreator base URL.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('TaskCreator requires a fixed HTTPS origin without credentials or path.');
  }
  if (!env.B24_TASKCREATOR_PRIVATE_KEY_FILE) throw new Error('TaskCreator signing key file is required.');
  return { baseUrl: base.origin, keyFile: env.B24_TASKCREATOR_PRIVATE_KEY_FILE };
}

export async function signTaskcreatorRequest(privateKey, operation, method, path, dealId) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: `taskcreator:${operation}`, deal_id: dealId, method, path })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' }).setIssuer('bitrix24-mcp')
    .setAudience('ges-assistant-taskcreator').setSubject('bitrix24-mcp-taskcreator')
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 60).setJti(randomUUID()).sign(privateKey);
}

export async function callTaskcreator(name, args, { config = taskcreatorConfig(), request = axios.request } = {}) {
  if (!config) throw new Error('TaskCreator integration is disabled.');
  const op = taskcreatorOperations[name];
  if (!op) throw new Error('Unknown TaskCreator operation.');
  const params = z.object({ ...deal, ...op[2] }).strict().parse(args);
  const [method, pathFor] = op;
  const path = pathFor(params);
  let token;
  try {
    const keyMaterial = await readFile(config.keyFile, 'utf8');
    const signer = await importPKCS8(keyMaterial, 'EdDSA');
    token = await signTaskcreatorRequest(signer, name, method, path, params.deal_id);
  } catch { throw new Error('TaskCreator signing key is unavailable or invalid.'); }
  const { deal_id, type_key, confirm, ...body } = params;
  const data = ['validate', 'create_draft'].includes(name) ? body.definition : body;
  try {
    const response = await request({ method, url: config.baseUrl + path,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(method === 'GET' ? { params: name === 'list' ? body : undefined } : { data }),
      timeout: 120000, maxRedirects: 0, proxy: false,
    });
    return response.data;
  } catch (error) {
    // Never let Axios request/header/key material reach the MCP error wrapper.
    const status = error.response?.status;
    const detail = error.response?.data?.detail;
    const safeCode = typeof detail === 'string' && /^[a-z][a-z0-9_]{1,100}$/.test(detail) ? ` (${detail})` : '';
    throw new Error(status ? `TaskCreator HTTP ${status}${safeCode}. Refresh state before another write.`
      : 'TaskCreator transport failure; write outcome may be unknown. Do not automatically repeat.');
  }
}

export function registerTaskcreatorTools(server, wrap) {
  if (!taskcreatorConfig()) return;
  for (const [name, [, , fields, description]] of Object.entries(taskcreatorOperations)) {
    server.tool(`b24_taskcreator_${name}`, description, { ...deal, ...fields }, wrap(args => callTaskcreator(name, args)));
  }
}

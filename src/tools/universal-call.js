import { z } from 'zod';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';

export const callSchema = z.object({
  method: z.string().describe(
    'REST-метод Bitrix24. Примеры: crm.deal.list, tasks.task.add, disk.folder.getchildren, im.notify.personal.add'
  ),
  params: z.record(z.any()).optional().default({}).describe(
    'Параметры метода в виде JSON-объекта. Пример: { "filter": { "STAGE_ID": "WON" }, "select": ["ID","TITLE"] }'
  ),
  webhook_url: z.string().url().optional().describe('Опциональный вебхук, используется значение по умолчанию, если не указано'),
  confirm: z.boolean().optional().default(false).describe('Обязательно true для destructive REST-методов'),
});

export function isDestructiveMethod(method) {
  return /\.(?:delete\w*|remove\w*|archive|kill)$/i.test(method);
}

function requireDestructiveConfirmation(methods, confirm) {
  const destructive = methods.filter(isDestructiveMethod);
  if (destructive.length && confirm !== true) {
    throw new Error(`Destructive REST method requires confirm: true: ${destructive.join(', ')}`);
  }
}

export async function universalCall({ method, params = {}, webhook_url, confirm = false }) {
  requireDestructiveConfirmation([method], confirm);
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const response = await client.call(method, params);
  return {
    method,
    portal: client.portal,
    result: response.result,
    total: response.total ?? null,
    next: response.next ?? null,
  };
}

// ─── Batch ────────────────────────────────────────────────────────────────────

export const batchSchema = z.object({
  calls: z.record(z.object({
    method: z.string(),
    params: z.record(z.any()).optional().default({}),
  })).describe(
    'Объект, где каждый ключ — это алиас, а значение — { method, params }. ' +
    'Параметры могут ссылаться на предыдущие результаты через $result[alias][поле]. ' +
    'Пример: { "deals": { "method": "crm.deal.list", "params": { "filter": { "STAGE_ID": "NEW" } } } }'
  ),
  webhook_url: z.string().url().optional(),
  confirm: z.boolean().optional().default(false).describe('Обязательно true, если batch содержит destructive REST-методы'),
});

export async function universalBatch({ calls, webhook_url, confirm = false }) {
  requireDestructiveConfirmation(Object.values(calls).map((call) => call.method), confirm);
  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  // Bitrix24 batch format
  const cmd = {};
  for (const [alias, call] of Object.entries(calls)) {
    const paramStr = Object.entries(call.params || {})
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v)}`)
      .join('&');
    cmd[alias] = `${call.method}?${paramStr}`;
  }

  const response = await client.call('batch', { cmd, halt: 0 });
  return {
    portal: client.portal,
    result: response.result?.result ?? response.result,
    errors: response.result?.result_error ?? {},
    total: response.result?.result_total ?? {},
  };
}

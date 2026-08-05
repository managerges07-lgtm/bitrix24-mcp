import { z } from 'zod';
import { Bitrix24Client } from '../bitrix24/client.js';
import { fetchAllPages } from '../utils/pagination.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';

// Соответствие сущности базовому методу REST API
const ENTITY_METHOD = {
  deal:     'crm.deal',
  contact:  'crm.contact',
  company:  'crm.company',
  lead:     'crm.lead',
  quote:    'crm.quote',
  invoice:  'crm.invoice',
  order:    'sale.order',
  // SPA (смарт-процессы) использует crm.item с entityTypeId
};

function resolveMethod(entity, entityTypeId) {
  if (entityTypeId) return { base: 'crm.item', extra: { entityTypeId } };
  const base = ENTITY_METHOD[entity?.toLowerCase()];
  if (!base) throw new Error(`Неизвестная сущность: "${entity}". Используйте deal, contact, company, lead, quote, invoice или передайте entityTypeId для SPA.`);
  return { base, extra: {} };
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

export const crmListSchema = z.object({
  entity: z.string().optional().describe('Тип сущности: deal, contact, company, lead, quote, invoice'),
  entity_type_id: z.number().int().optional().describe('ID SPA (смарт-процесса). Альтернатива entity для пользовательских процессов'),
  filter: z.record(z.any()).optional().default({}).describe('Фильтры. Пример: { "STAGE_ID": "WON", ">DATE_CREATE": "2026-01-01" }'),
  select: z.array(z.string()).optional().describe('Возвращаемые поля. Пример: ["ID","TITLE","STAGE_ID","ASSIGNED_BY_ID"]'),
  order: z.record(z.string()).optional().describe('Сортировка. Пример: { "DATE_CREATE": "DESC" }'),
  all_pages: z.boolean().optional().default(false).describe('Если true, загружает все записи с автоматической постраничной навигацией'),
  webhook_url: z.string().url().optional(),
});

export async function crmList({ entity, entity_type_id, filter = {}, select, order, all_pages = false, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { base, extra } = resolveMethod(entity, entity_type_id);
  const params = { filter, ...extra, ...(select ? { select } : {}), ...(order ? { order } : {}) };

  let items;
  if (all_pages) {
    items = await fetchAllPages(client, `${base}.list`, params);
  } else {
    const res = await client.call(`${base}.list`, params);
    items = res.result?.items ?? res.result ?? [];
  }

  return { entity: entity || `SPA_${entity_type_id}`, portal: client.portal, count: items.length, items };
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export const crmGetSchema = z.object({
  entity: z.string().optional(),
  entity_type_id: z.number().int().optional(),
  id: z.union([z.string(), z.number()]).describe('ID записи'),
  webhook_url: z.string().url().optional(),
});

export async function crmGet({ entity, entity_type_id, id, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { base, extra } = resolveMethod(entity, entity_type_id);
  const res = await client.call(`${base}.get`, { id, ...extra });
  return { entity: entity || `SPA_${entity_type_id}`, portal: client.portal, item: res.result?.item ?? res.result };
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

export const crmCreateSchema = z.object({
  entity: z.string().optional(),
  entity_type_id: z.number().int().optional(),
  fields: z.record(z.any()).describe('Поля создаваемой записи. Пример: { "TITLE": "Новая сделка", "STAGE_ID": "NEW", "ASSIGNED_BY_ID": 1 }'),
  params: z.record(z.any()).optional().describe('Дополнительные параметры метода (например: REGISTER_SONET_EVENT)'),
  webhook_url: z.string().url().optional(),
});

export async function crmCreate({ entity, entity_type_id, fields, params = {}, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { base, extra } = resolveMethod(entity, entity_type_id);
  // entityTypeId — параметр верхнего уровня crm.item.add; внутри fields метод его не видит
  const res = await client.call(`${base}.add`, { fields, params, ...extra });
  const id = res.result?.item?.id ?? res.result;
  return { entity: entity || `SPA_${entity_type_id}`, portal: client.portal, created_id: id };
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

export const crmUpdateSchema = z.object({
  entity: z.string().optional(),
  entity_type_id: z.number().int().optional(),
  id: z.union([z.string(), z.number()]),
  fields: z.record(z.any()).describe('Обновляемые поля'),
  params: z.record(z.any()).optional(),
  webhook_url: z.string().url().optional(),
});

export async function crmUpdate({ entity, entity_type_id, id, fields, params = {}, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { base, extra } = resolveMethod(entity, entity_type_id);
  await client.call(`${base}.update`, { id, fields, params, ...extra });
  return { entity: entity || `SPA_${entity_type_id}`, portal: client.portal, updated_id: id, success: true };
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

export const crmDeleteSchema = z.object({
  entity: z.string().optional(),
  entity_type_id: z.number().int().optional(),
  id: z.union([z.string(), z.number()]),
  webhook_url: z.string().url().optional(),
});

export async function crmDelete({ entity, entity_type_id, id, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { base, extra } = resolveMethod(entity, entity_type_id);
  await client.call(`${base}.delete`, { id, ...extra });
  return { entity: entity || `SPA_${entity_type_id}`, portal: client.portal, deleted_id: id, success: true };
}

// ─── FIELDS ───────────────────────────────────────────────────────────────────

export const crmFieldsSchema = z.object({
  entity: z.string().optional().describe('Тип сущности: deal, contact, company, lead'),
  entity_type_id: z.number().int().optional().describe('ID SPA'),
  webhook_url: z.string().url().optional(),
});

export async function crmFields({ entity, entity_type_id, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { base, extra } = resolveMethod(entity, entity_type_id);
  const res = await client.call(`${base}.fields`, extra);
  const fields = res.result?.fields ?? res.result ?? {};
  const fieldList = Object.entries(fields).map(([code, def]) => ({ code, ...def }));
  return {
    entity: entity || `SPA_${entity_type_id}`,
    portal: client.portal,
    total_fields: fieldList.length,
    fields: fieldList,
  };
}

// ─── TIMELINE ─────────────────────────────────────────────────────────────────

export const timelineAddSchema = z.object({
  entity: z.string().describe('Тип сущности CRM: deal, contact, company, lead'),
  entity_id: z.union([z.string(), z.number()]).describe('ID записи CRM'),
  comment: z.string().describe('Текст комментария для добавления в таймлайн'),
  webhook_url: z.string().url().optional(),
});

export async function timelineAdd({ entity, entity_id, comment, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const entityMap = { deal: 'CRM_DEAL', contact: 'CRM_CONTACT', company: 'CRM_COMPANY', lead: 'CRM_LEAD' };
  const entityCode = entityMap[entity?.toLowerCase()] ?? entity.toUpperCase();
  const res = await client.call('crm.timeline.comment.add', {
    fields: { ENTITY_ID: entity_id, ENTITY_TYPE: entityCode, COMMENT: comment },
  });
  return { portal: client.portal, entity, entity_id, comment_id: res.result, success: true };
}

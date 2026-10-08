import { z } from 'zod';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';

// ─────────────────────────────────────────────────────────────────────────────
// Чтение и отправка почты (Bitrix24 REST v3, семейство методов mail.*)
//
// Это методы REST v3: они находятся под /rest/api/ (client.callV3), используют
// постраничную навигацию через объект { page, limit, offset } и возвращают данные
// в result.items / result.item. Требуют scope `mail` у вебхука (отличается от
// `mailservice`) и коммерческий тариф Bitrix24.
// ─────────────────────────────────────────────────────────────────────────────

// Постраничная навигация v3: отправляется, только если пользователь задал хотя бы один параметр.
const paginationShape = {
  page: z.number().int().positive().optional().describe('Номер страницы (начиная с 1)'),
  limit: z.number().int().positive().optional().describe('Количество записей на странице. По умолчанию в Bitrix24: 20'),
  offset: z.number().int().nonnegative().optional().describe('Смещение записей'),
};

function buildPagination({ page, limit, offset }) {
  const pagination = {};
  if (page !== undefined) pagination.page = page;
  if (limit !== undefined) pagination.limit = limit;
  if (offset !== undefined) pagination.offset = offset;
  return Object.keys(pagination).length ? { pagination } : {};
}

// ─── LIST MAILBOXES ───────────────────────────────────────────────────────────

export const mailMailboxListSchema = z.object({
  name: z.string().optional().describe('Фрагмент имени почтового ящика для фильтрации'),
  email: z.string().optional().describe('Фрагмент email для фильтрации'),
  ...paginationShape,
  webhook_url: z.string().url().optional(),
});

export async function mailMailboxList({ name, email, page, limit, offset, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const res = await client.callV3('mail.mailbox.list', {
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...buildPagination({ page, limit, offset }),
  });
  const mailboxes = res.result?.items ?? [];
  return { portal: client.portal, count: mailboxes.length, mailboxes };
}

// ─── LIST MESSAGES ────────────────────────────────────────────────────────────

export const mailMessageListSchema = z.object({
  mailbox_id: z.union([z.string(), z.number()]).describe(
    'ID почтового ящика. Получается через b24_mail_mailbox_list'
  ),
  search_query: z.string().optional().describe('Поиск по содержимому и метаданным письма'),
  date_from: z.string().optional().describe('Начало периода в ISO 8601. Пример: "2026-01-01T00:00:00+03:00"'),
  date_to: z.string().optional().describe('Конец периода в ISO 8601. Пример: "2026-01-31T23:59:59+03:00"'),
  is_seen: z.boolean().optional().describe('Фильтр по прочтению: true — только прочитанные, false — только непрочитанные'),
  has_attachments: z.boolean().optional().describe('Фильтр по вложениям: true — только с вложениями, false — только без вложений'),
  folder: z.string().optional().describe('Имя или путь почтовой папки (например, "INBOX")'),
  ...paginationShape,
  webhook_url: z.string().url().optional(),
});

export async function mailMessageList({ mailbox_id, search_query, date_from, date_to, is_seen, has_attachments, folder, page, limit, offset, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const res = await client.callV3('mail.message.list', {
    mailboxId: mailbox_id,
    ...(search_query ? { searchQuery: search_query } : {}),
    ...(date_from ? { dateFrom: date_from } : {}),
    ...(date_to ? { dateTo: date_to } : {}),
    ...(is_seen !== undefined ? { isSeen: is_seen } : {}),
    ...(has_attachments !== undefined ? { hasAttachments: has_attachments } : {}),
    ...(folder ? { folder } : {}),
    ...buildPagination({ page, limit, offset }),
  });
  const messages = res.result?.items ?? [];
  return { portal: client.portal, mailbox_id, count: messages.length, messages };
}

// ─── GET MESSAGE ──────────────────────────────────────────────────────────────

export const mailMessageGetSchema = z.object({
  id: z.union([z.string(), z.number()]).describe('ID письма. Получается через b24_mail_message_list'),
  select: z.array(z.string()).optional().describe(
    'Поля, которые нужно вернуть. Доступны: id, mailboxId, mailboxEmail, subject, from, to, ' +
    'cc, date, isSeen, hasAttachments, url, bindings, body'
  ),
  webhook_url: z.string().url().optional(),
});

export async function mailMessageGet({ id, select, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const res = await client.callV3('mail.message.get', {
    id,
    ...(select ? { select } : {}),
  });
  return { portal: client.portal, message: res.result?.item ?? null };
}

// ─── GET THREAD ───────────────────────────────────────────────────────────────

export const mailMessageThreadSchema = z.object({
  id: z.union([z.string(), z.number()]).describe('ID любого письма из цепочки'),
  limit: z.number().int().positive().max(50).optional().describe(
    'Максимум писем в ответе. По умолчанию 20, максимум 50'
  ),
  webhook_url: z.string().url().optional(),
});

export async function mailMessageThread({ id, limit, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const res = await client.callV3('mail.message.thread', {
    id,
    ...(limit !== undefined ? { limit } : {}),
  });
  const messages = res.result ?? [];
  return { portal: client.portal, count: messages.length, messages };
}

// https://apidocs.bitrix24.ru/api-reference/mail/mailbox/mail-mailbox-senders.html
export const mailMailboxSendersSchema = z.object({
  ...paginationShape,
  limit: z.number().int().positive().max(100).optional().describe('Количество отправителей: по умолчанию 25, максимум 100'),
  webhook_url: z.string().url().optional(),
});

export async function mailMailboxSenders(args) {
  const { page, limit, offset, webhook_url } = mailMailboxSendersSchema.parse(args);
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const res = await client.callV3('mail.mailbox.senders', buildPagination({ page, limit, offset }));
  const senders = res.result?.items ?? [];
  return { portal: client.portal, count: senders.length, senders };
}

// https://apidocs.bitrix24.ru/api-reference/mail/message/mail-message-send.html
const emailAddress = z.string().trim().email();
export const mailMessageSendSchema = z.object({
  from: emailAddress.describe('Email отправителя из b24_mail_mailbox_senders'),
  to: z.array(emailAddress).min(1).describe('Email-адреса получателей, минимум один'),
  subject: z.string().min(1).refine(value => value.trim().length > 0 && !/[\r\n]/.test(value), 'Укажите непустую тему без переносов строк').describe('Тема письма'),
  body: z.string().min(1).refine(value => value.trim().length > 0, 'Укажите текст письма').describe('Текст письма или базовый HTML; передаётся без изменений'),
  cc: z.array(emailAddress).optional().describe('Email-адреса получателей копии'),
  bcc: z.array(emailAddress).optional().describe('Email-адреса получателей скрытой копии'),
  webhook_url: z.string().url().optional(),
}).strict();

export async function mailMessageSend(args) {
  const { webhook_url, ...params } = mailMessageSendSchema.parse(args);
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  // callV3 does not retry writes after timeouts, HTTP 429 or transport failures.
  const res = await client.callV3('mail.message.send', params);
  if (typeof res.result?.success !== 'boolean' || !Array.isArray(res.result?.to)) {
    throw new Error('Некорректный ответ mail.message.send: результат отправки неизвестен. Проверьте отправленные письма перед повтором.');
  }
  return { portal: client.portal, success: res.result.success, to: res.result.to };
}

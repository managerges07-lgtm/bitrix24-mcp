import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveNoteWebhook } from '../utils/resolve-webhook.js';

// ─────────────────────────────────────────────────────────────────────────────
// База знаний 2.0 (модуль note, REST v3)
//
// Это ДРУГОЙ движок, не тот, на котором работают инструменты b24_kb_* (landing).
// Оба живут на портале параллельно:
//
//   b24_kb_*  — сайт landing со страницами из блоков вёрстки, правка по ID блоков
//               черновика, обязательная публикация.
//   b24_kb2_* — база (collection) с деревом документов, содержимое — Markdown одним
//               полем, публикации нет: документ живой сразу после add / update.
//
// Особенности, из которых выросли решения ниже:
//
// • Методы note.* — REST v3, вызывать только через client.callV3. Классический
//   client.call вернёт ERROR_METHOD_NOT_FOUND. Проверять доступность методов через
//   v1-интроспекцию (method.get) бесполезно: она отвечает isExisting: false даже для
//   рабочих v3-методов.
// • Требуется scope `note` («База знаний») у вебхука. Он выдаётся ТОЛЬКО руками в
//   интерфейсе Битрикса, через API не добавить. У общего вебхука портала его обычно
//   нет, поэтому инструменты берут вебхук из B24_NOTE_WEBHOOK — см. resolveNoteWebhook.
// • Ни в одном DTO нет адреса страницы (проверены все шесть). Ссылку собираем сами:
//   https://{портал}/note/document/{id}/.
// • Правами через API не управлять: методов доступа в note.* нет, раздел по умолчанию
//   виден только администраторам. Единственный намёк — policyLevel в списке баз.
// ─────────────────────────────────────────────────────────────────────────────

// Bitrix24 не отдаёт ссылку на документ ни в одном ответе, а подобрать её перебором
// нельзя: портал редиректит на авторизацию ЛЮБОЙ URL, включая несуществующий.
// Поэтому собираем адрес сами — иначе модели нечего дать пользователю.
function documentUrl(portal, id) {
  return `https://${portal}/note/document/${id}/`;
}

function withUrl(item, portal) {
  if (!item) return null;
  return { ...item, url: documentUrl(portal, item.id) };
}

// Дерево приходит с вложенными children — размечаем ссылками все уровни.
function treeWithUrls(items, portal) {
  return (items ?? []).map(item => ({
    ...item,
    url: documentUrl(portal, item.id),
    ...(item.children ? { children: treeWithUrls(item.children, portal) } : {}),
  }));
}

// Без scope `note` портал отвечает 403 INSUFFICIENTSCOPEEXCEPTION с текстом
// «Недостаточно прав доступа: отсутствует необходимый scope» — по нему не понять,
// какой именно scope и где его брать. Подменяем на инструкцию.
async function noteCall(client, method, params = {}, options = {}) {
  try {
    return await client.callV3(method, params, options);
  } catch (err) {
    if (String(err.b24?.code ?? '').includes('INSUFFICIENTSCOPE')) {
      throw new Error(
        `Вебхук портала ${client.portal} не имеет scope «База знаний» (note), ` +
        'поэтому методы note.* (База знаний 2.0) недоступны. Scope выдаётся только вручную ' +
        'в интерфейсе Битрикс24: Разработчикам → Другое → Входящие вебхуки → правка вебхука. ' +
        'Либо укажите другой вебхук — параметром webhook_url или переменной окружения ' +
        'B24_NOTE_WEBHOOK (её используют все инструменты b24_kb2_*).'
      );
    }
    throw err;
  }
}

const webhookShape = {
  webhook_url: z.string().url().optional().describe(
    'Вебхук со scope note. По умолчанию берётся B24_NOTE_WEBHOOK, затем B24_DEFAULT_WEBHOOK'
  ),
};

// ─── СПИСОК БАЗ ЗНАНИЙ ────────────────────────────────────────────────────────

export const kb2ListSchema = z.object({
  limit: z.number().int().positive().optional().default(100).describe('Максимум баз знаний в ответе'),
  ...webhookShape,
});

export async function kb2List({ limit = 100, webhook_url }) {
  const client = new Bitrix24Client(resolveNoteWebhook(webhook_url));

  // Постраничная навигация здесь курсорная: limit + afterCursor из nextCursor
  // предыдущего ответа (а не page/limit/offset, как в mail.*).
  const collections = [];
  let afterCursor = null;

  while (collections.length < limit) {
    const res = await noteCall(client, 'note.collection.list', {
      pagination: {
        limit: Math.min(50, limit - collections.length),
        ...(afterCursor ? { afterCursor } : {}),
      },
    });
    const chunk = res.result?.items ?? [];
    collections.push(...chunk);
    afterCursor = res.result?.nextCursor ?? null;
    if (!afterCursor || chunk.length === 0) break;
  }

  return {
    portal: client.portal,
    count: collections.length,
    knowledge_bases: collections.slice(0, limit),
  };
}

// ─── СОЗДАНИЕ БАЗЫ ЗНАНИЙ ─────────────────────────────────────────────────────

export const kb2CreateSchema = z.object({
  name: z.string().describe('Название базы знаний. Пример: "Помощник ГЕС"'),
  position: z.number().int().optional().describe('Позиция в списке баз. Шаг между базами обычно 1000'),
  ...webhookShape,
});

export async function kb2Create({ name, position, webhook_url }) {
  const client = new Bitrix24Client(resolveNoteWebhook(webhook_url));

  const res = await noteCall(client, 'note.collection.add', {
    fields: { name, ...(position !== undefined ? { position } : {}) },
  }, { idempotencyKey: randomUUID() });

  return {
    portal: client.portal,
    knowledge_base: res.result?.item ?? null,
    // Раздел «База знаний» по умолчанию виден только администраторам, а методов
    // управления доступом в note.* нет — права выдаются в интерфейсе.
    note: 'Доступ сотрудников к базе выдаётся только в интерфейсе Битрикс24 (можно на отдел целиком): API прав не меняет.',
    success: true,
  };
}

// ─── УДАЛЕНИЕ БАЗЫ ЗНАНИЙ ─────────────────────────────────────────────────────

export const kb2DeleteSchema = z.object({
  id: z.union([z.string(), z.number()]).describe('ID базы знаний. Получается через b24_kb2_list'),
  confirm: z.boolean().describe(
    'Подтверждение каскадного удаления. Только true выполняет удаление: база уезжает в корзину ' +
    'вместе со ВСЕМИ своими документами'
  ),
  ...webhookShape,
});

export async function kb2Delete({ id, confirm, webhook_url }) {
  if (confirm !== true) {
    throw new Error(
      'Удаление базы знаний каскадное: вместе с ней в корзину уходят все её документы. ' +
      'Передайте confirm: true, если это действительно нужно.'
    );
  }

  const client = new Bitrix24Client(resolveNoteWebhook(webhook_url));
  const res = await noteCall(client, 'note.collection.delete', { id: Number(id) });

  return {
    portal: client.portal,
    id,
    deleted: res.result?.result ?? true,
    success: true,
  };
}

// ─── ДЕРЕВО ДОКУМЕНТОВ ────────────────────────────────────────────────────────

export const kb2TreeSchema = z.object({
  collection_id: z.union([z.string(), z.number()]).describe('ID базы знаний. Получается через b24_kb2_list'),
  ...webhookShape,
});

export async function kb2Tree({ collection_id, webhook_url }) {
  const client = new Bitrix24Client(resolveNoteWebhook(webhook_url));

  const res = await noteCall(client, 'note.document.tree.list', {
    collectionId: Number(collection_id),
  });

  return {
    portal: client.portal,
    collection_id,
    // Дерево отдаётся целиком, но очень большое портал обрезает.
    truncated: res.result?.truncated ?? false,
    documents: treeWithUrls(res.result?.items, client.portal),
  };
}

// ─── ЧТЕНИЕ ДОКУМЕНТА ─────────────────────────────────────────────────────────

// Параметр select у note.document.get объявлен в спецификации, но портал его
// игнорирует: ответ всегда приходит целиком, а неизвестное имя поля к тому же
// роняет вызов с UNKNOWNDTOPROPERTYEXCEPTION. Поэтому в схеме его нет.
export const kb2PageGetSchema = z.object({
  id: z.union([z.string(), z.number()]).describe('ID документа. Получается через b24_kb2_tree или b24_kb2_search'),
  ...webhookShape,
});

export async function kb2PageGet({ id, webhook_url }) {
  const client = new Bitrix24Client(resolveNoteWebhook(webhook_url));

  const res = await noteCall(client, 'note.document.get', { id: Number(id) });

  return { portal: client.portal, document: withUrl(res.result?.item, client.portal) };
}

// ─── СОЗДАНИЕ ДОКУМЕНТА ───────────────────────────────────────────────────────

export const kb2PageCreateSchema = z.object({
  collection_id: z.union([z.string(), z.number()]).describe('ID базы знаний, в которой создаётся документ'),
  title: z.string().describe('Заголовок документа'),
  markdown: z.string().optional().describe('Содержимое в Markdown. Максимум 1 048 576 байт'),
  parent_id: z.union([z.string(), z.number()]).optional().describe(
    'ID родительского документа, если статья вкладывается в раздел дерева'
  ),
  idempotency_key: z.string().optional().describe(
    'Ключ защиты от дублей при повторном вызове (портал хранит ответ 24 часа). ' +
    'Если не указан, генерируется автоматически на время одного вызова'
  ),
  ...webhookShape,
});

export async function kb2PageCreate({ collection_id, title, markdown, parent_id, idempotency_key, webhook_url }) {
  const client = new Bitrix24Client(resolveNoteWebhook(webhook_url));

  // Ключ идемпотентности переживает внутренние ретраи клиента (429 / таймаут):
  // без него повтор запроса создал бы второй документ.
  const res = await noteCall(client, 'note.document.add', {
    fields: {
      collectionId: Number(collection_id),
      title,
      ...(markdown !== undefined ? { markdown } : {}),
      ...(parent_id !== undefined ? { parentId: Number(parent_id) } : {}),
    },
  }, { idempotencyKey: idempotency_key || randomUUID() });

  return {
    portal: client.portal,
    // Публикации в КБ 2.0 нет: документ доступен по ссылке сразу.
    document: withUrl(res.result?.item, client.portal),
    success: true,
  };
}

// ─── ПРАВКА ДОКУМЕНТА ─────────────────────────────────────────────────────────

export const kb2PageUpdateSchema = z.object({
  id: z.union([z.string(), z.number()]).describe('ID документа'),
  title: z.string().optional().describe('Новый заголовок'),
  markdown: z.string().optional().describe(
    'Новое содержимое в Markdown. Заменяет текст ЦЕЛИКОМ, дописать кусок нельзя: ' +
    'сначала прочитайте текущий через b24_kb2_page_get'
  ),
  overwrite: z.boolean().optional().describe(
    'Перезаписать несохранённые правки совместного редактора. Нужен, если обычный вызов ' +
    'вернул конфликт: кто-то держит документ открытым в редакторе'
  ),
  ...webhookShape,
});

export async function kb2PageUpdate({ id, title, markdown, overwrite, webhook_url }) {
  if (title === undefined && markdown === undefined) {
    throw new Error('Укажите хотя бы одно из полей: title или markdown.');
  }

  const client = new Bitrix24Client(resolveNoteWebhook(webhook_url));

  const res = await noteCall(client, 'note.document.update', {
    id: Number(id),
    fields: {
      ...(title !== undefined ? { title } : {}),
      ...(markdown !== undefined ? { markdown } : {}),
    },
    ...(overwrite !== undefined ? { overwrite } : {}),
  });

  return {
    portal: client.portal,
    document: withUrl(res.result?.item, client.portal),
    success: true,
  };
}

// ─── УДАЛЕНИЕ ДОКУМЕНТА ───────────────────────────────────────────────────────

export const kb2PageDeleteSchema = z.object({
  id: z.union([z.string(), z.number()]).describe('ID документа'),
  confirm: z.literal(true).describe('Подтверждение каскадного удаления документа и вложенных документов'),
  ...webhookShape,
});

export async function kb2PageDelete({ id, confirm, webhook_url }) {
  if (confirm !== true) {
    throw new Error('Каскадное удаление документа требует confirm: true.');
  }
  const client = new Bitrix24Client(resolveNoteWebhook(webhook_url));

  const res = await noteCall(client, 'note.document.delete', { id: Number(id) });

  return {
    portal: client.portal,
    id,
    deleted: res.result?.result ?? true,
    success: true,
  };
}

// ─── ПОИСК ПО ДОКУМЕНТАМ ──────────────────────────────────────────────────────

export const kb2SearchSchema = z.object({
  query: z.string().describe('Поисковый запрос: ищет и по заголовкам, и по тексту документов'),
  limit: z.number().int().positive().optional().describe('Максимум результатов в ответе'),
  ...webhookShape,
});

export async function kb2Search({ query, limit, webhook_url }) {
  const client = new Bitrix24Client(resolveNoteWebhook(webhook_url));

  const res = await noteCall(client, 'note.document.search.list', {
    query,
    ...(limit !== undefined ? { pagination: { limit } } : {}),
  });

  const items = res.result?.items ?? [];

  return {
    portal: client.portal,
    query,
    count: items.length,
    has_more: res.result?.hasMore ?? false,
    // В результатах поиска ID документа лежит в documentId, а не в id.
    results: items.map(item => ({ ...item, url: documentUrl(client.portal, item.documentId) })),
  };
}

// ─── ЗАГРУЗКА ФАЙЛА В ДОКУМЕНТ ────────────────────────────────────────────────

export const kb2FileAddSchema = z.object({
  document_id: z.union([z.string(), z.number()]).describe('ID документа, к которому привязывается файл'),
  file_name: z.string().describe(
    'Имя файла с расширением. Разрешены: png, jpg, jpeg, gif, webp, svg, pdf, txt, md, csv, ' +
    'doc, docx, xls, xlsx, ppt, pptx, mp4, webm, mov'
  ),
  content_base64: z.string().describe('Содержимое файла в Base64. Размер по умолчанию до 25 МиБ'),
  idempotency_key: z.string().optional().describe(
    'Ключ защиты от дублей при повторном вызове (портал хранит ответ 24 часа). ' +
    'Если не указан, генерируется автоматически на время одного вызова'
  ),
  ...webhookShape,
});

export async function kb2FileAdd({ document_id, file_name, content_base64, idempotency_key, webhook_url }) {
  const client = new Bitrix24Client(resolveNoteWebhook(webhook_url));

  const res = await noteCall(client, 'note.file.add', {
    documentId: Number(document_id),
    fileName: file_name,
    fileContent: content_base64,
  }, { idempotencyKey: idempotency_key || randomUUID() });

  const file = res.result?.item ?? null;

  return {
    portal: client.portal,
    document_id,
    file,
    // Загрузка только кладёт файл: в текст документа он сам не попадает.
    note: file?.assetMarkdown
      ? `Вставьте ${file.assetMarkdown} в нужное место Markdown и сохраните документ через b24_kb2_page_update. ` +
        'У блока есть параметры width и align: [[image fileId=… width=600 align=center]]. ' +
        'Удалить загруженный файл через API нельзя, поэтому не перезаливайте картинку при каждой правке.'
      : 'Файл загружен, но портал не вернул assetMarkdown — вставить его в текст нечем.',
    success: true,
  };
}

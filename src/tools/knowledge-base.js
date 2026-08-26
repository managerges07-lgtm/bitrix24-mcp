import { z } from 'zod';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';
import { parseElements, matchSelector, htmlToText } from '../utils/landing-html.js';

// ─────────────────────────────────────────────────────────────────────────────
// База знаний Bitrix24
//
// База знаний — это сайт модуля landing с TYPE = KNOWLEDGE, её статьи — страницы
// (landing), а содержимое статьи — блоки вёрстки. Отсюда особенности:
//
// • Во ВСЕ вызовы landing.* по базам знаний нужно передавать верхнеуровневый
//   `scope: "KNOWLEDGE"`. Без него landing.site.getList молча отдаёт только обычные
//   сайты, а landing.block.* / landing.landing.* возвращают LANDING_NOT_EXIST.
//   Все инструменты этого файла подставляют scope сами.
// • У страницы две версии: черновик и опубликованная. Правки методами landing.block.*
//   идут в черновик, до публикации их не видно. ID блоков в версиях РАЗНЫЕ, поэтому
//   для правки нужно брать список блоков черновика, а не публичной версии.
// • Требуется scope `landing` («Сайты и магазины») у вебхука и коммерческий тариф.
// ─────────────────────────────────────────────────────────────────────────────

const KNOWLEDGE_SCOPE = 'KNOWLEDGE';

// Bitrix24 отдаёт не больше 50 записей за раз; добираем через start, пока приходят
// полные пачки. Полагаться на `total` нельзя — методы landing его не заполняют.
async function fetchLandingList(client, method, params, limit) {
  const items = [];
  let start = 0;

  while (items.length < limit) {
    const res = await client.call(method, { ...params, start });
    const chunk = res.result ?? [];
    items.push(...chunk);
    if (chunk.length < 50) break;
    start += 50;
  }

  return items.slice(0, limit);
}

// ─── СПИСОК БАЗ ЗНАНИЙ ────────────────────────────────────────────────────────

export const kbListSchema = z.object({
  title: z.string().optional().describe('Фрагмент названия для фильтрации. Пример: "Отдел продаж"'),
  only_active: z.boolean().optional().default(false).describe('Только опубликованные базы знаний'),
  limit: z.number().int().positive().optional().default(200).describe('Максимум записей в ответе'),
  webhook_url: z.string().url().optional(),
});

export async function kbList({ title, only_active = false, limit = 200, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  const filter = { '=DELETED': 'N' };
  if (title) filter['%TITLE'] = title;
  if (only_active) filter['=ACTIVE'] = 'Y';

  const sites = await fetchLandingList(client, 'landing.site.getList', {
    scope: KNOWLEDGE_SCOPE,
    params: {
      select: ['ID', 'TITLE', 'CODE', 'ACTIVE', 'DATE_CREATE', 'DATE_MODIFY'],
      filter,
      order: { DATE_MODIFY: 'DESC' },
    },
  }, limit);

  return {
    portal: client.portal,
    count: sites.length,
    knowledge_bases: sites.map(s => ({
      id: s.ID,
      title: s.TITLE,
      code: s.CODE,
      active: s.ACTIVE === 'Y',
      created: s.DATE_CREATE,
      modified: s.DATE_MODIFY,
    })),
  };
}

// ─── СПИСОК СТАТЕЙ БАЗЫ ЗНАНИЙ ────────────────────────────────────────────────

export const kbPagesSchema = z.object({
  kb_id: z.union([z.string(), z.number()]).describe('ID базы знаний. Получается через b24_kb_list'),
  title: z.string().optional().describe('Фрагмент названия страницы для фильтрации'),
  limit: z.number().int().positive().optional().default(200).describe('Максимум записей в ответе'),
  webhook_url: z.string().url().optional(),
});

export async function kbPages({ kb_id, title, limit = 200, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  const filter = { SITE_ID: kb_id, '=DELETED': 'N' };
  if (title) filter['%TITLE'] = title;

  const pages = await fetchLandingList(client, 'landing.landing.getList', {
    scope: KNOWLEDGE_SCOPE,
    params: {
      select: ['ID', 'TITLE', 'CODE', 'SITE_ID', 'ACTIVE', 'FOLDER_ID', 'DATE_CREATE', 'DATE_MODIFY'],
      filter,
      order: { DATE_MODIFY: 'DESC' },
      get_urls: true,
      check_area: true,
    },
  }, limit);

  return {
    portal: client.portal,
    kb_id,
    count: pages.length,
    pages: pages.map(p => ({
      id: p.ID,
      title: p.TITLE,
      code: p.CODE,
      active: p.ACTIVE === 'Y',
      folder_id: p.FOLDER_ID,
      // Включаемая область (сайдбар, шаблон карточки) — служебная страница, не статья.
      is_area: Boolean(p.IS_AREA),
      public_url: p.PUBLIC_URL,
      created: p.DATE_CREATE,
      modified: p.DATE_MODIFY,
    })),
  };
}

// ─── СОДЕРЖИМОЕ СТАТЬИ ────────────────────────────────────────────────────────

// Сопоставляет селекторы из манифеста блока с его вёрсткой: для каждой ноды —
// текущие значения и готовый селектор с индексом для b24_kb_block_update.
function describeBlock(content, manifest) {
  const elements = parseElements(content);

  const nodes = Object.entries(manifest.nodes ?? {}).map(([selector, meta]) => ({
    selector,
    name: meta?.name ?? null,
    type: meta?.type ?? null,
    values: matchSelector(elements, selector).map((el, index) => {
      const value = { selector: `${selector}@${index}`, text: htmlToText(el.html) };
      if (el.attrs.src) value.src = el.attrs.src;
      if (el.attrs.alt) value.alt = el.attrs.alt;
      if (el.attrs.href) value.href = el.attrs.href;
      return value;
    }),
  }));

  const cards = Object.entries(manifest.cards ?? {}).map(([selector, meta]) => ({
    selector,
    name: meta?.name ?? null,
    count: matchSelector(elements, selector).length,
  }));

  return { nodes, cards };
}

export const kbPageGetSchema = z.object({
  page_id: z.union([z.string(), z.number()]).describe('ID страницы. Получается через b24_kb_pages'),
  block_id: z.union([z.string(), z.number()]).optional().describe('Ограничить выдачу одним блоком'),
  detail: z.enum(['text', 'nodes', 'html']).optional().default('text').describe(
    'Сколько подробностей вернуть по каждому блоку. ' +
    '"text" — извлечённый из вёрстки текст, один запрос на всю страницу, подходит для чтения. ' +
    '"nodes" — плюс карта редактируемых нод и карточек из манифеста блока с текущими значениями ' +
    'и готовыми селекторами для b24_kb_block_update; нужен перед правкой, стоит по запросу на блок. ' +
    '"html" — плюс сырой HTML блока'
  ),
  published: z.boolean().optional().default(false).describe(
    'true — читать опубликованную версию, false (по умолчанию) — черновик. ' +
    'ID блоков в версиях РАЗНЫЕ: для правки нужны ID из черновика'
  ),
  webhook_url: z.string().url().optional(),
});

export async function kbPageGet({ page_id, block_id, detail = 'text', published = false, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const editMode = !published;

  const listRes = await client.call('landing.block.getlist', {
    scope: KNOWLEDGE_SCOPE,
    lid: page_id,
    params: { edit_mode: editMode, get_content: detail !== 'nodes' },
  });

  let blocks = listRes.result ?? [];
  if (block_id !== undefined && block_id !== null) {
    blocks = blocks.filter(b => String(b.id) === String(block_id));
  }

  const described = [];
  for (const block of blocks) {
    const item = { id: block.id, code: block.code, name: block.name, active: block.active };

    if (detail === 'nodes') {
      // Манифест с селекторами нод отдаёт только getcontent, поштучно по блокам.
      const contentRes = await client.call('landing.block.getcontent', {
        scope: KNOWLEDGE_SCOPE,
        lid: page_id,
        block: block.id,
        editMode,
      });
      const data = contentRes.result ?? {};
      item.text = htmlToText(data.content ?? '');
      Object.assign(item, describeBlock(data.content ?? '', data.manifest ?? {}));
    } else {
      item.text = htmlToText(block.content ?? '');
      if (detail === 'html') item.html = block.content ?? '';
    }

    described.push(item);
  }

  return {
    portal: client.portal,
    page_id,
    version: editMode ? 'draft' : 'published',
    count: described.length,
    blocks: described,
  };
}

// ─── СОЗДАНИЕ И ПУБЛИКАЦИЯ СТАТЬИ ─────────────────────────────────────────────

export const kbPageCreateSchema = z.object({
  kb_id: z.union([z.string(), z.number()]).describe('ID базы знаний, в которой создаётся статья'),
  title: z.string().describe('Название статьи'),
  code: z.string().optional().describe(
    'Символьный код (адрес) страницы. Без "/" и без формата "__". Если не указан, генерируется из названия'
  ),
  description: z.string().optional().describe('Описание страницы'),
  folder_id: z.union([z.string(), z.number()]).optional().describe('ID раздела базы знаний, в который положить статью'),
  webhook_url: z.string().url().optional(),
});

export async function kbPageCreate({ kb_id, title, code, description, folder_id, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  const res = await client.call('landing.landing.add', {
    scope: KNOWLEDGE_SCOPE,
    fields: {
      SITE_ID: kb_id,
      TITLE: title,
      ...(code ? { CODE: code } : {}),
      ...(description ? { DESCRIPTION: description } : {}),
      ...(folder_id ? { FOLDER_ID: folder_id } : {}),
    },
  });

  return {
    portal: client.portal,
    page_id: res.result,
    kb_id,
    // Страница создаётся неактивной: наполнить блоками и вызвать b24_kb_page_publish.
    published: false,
    success: true,
  };
}

export const kbPagePublishSchema = z.object({
  page_id: z.union([z.string(), z.number()]).describe('ID страницы для публикации'),
  webhook_url: z.string().url().optional(),
});

export async function kbPagePublish({ page_id, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  const res = await client.call('landing.landing.publication', {
    scope: KNOWLEDGE_SCOPE,
    lid: page_id,
  });

  return { portal: client.portal, page_id, published: res.result === true, success: res.result === true };
}

// ─── БЛОКИ СТАТЬИ ─────────────────────────────────────────────────────────────

export const kbBlockAddSchema = z.object({
  page_id: z.union([z.string(), z.number()]).describe('ID страницы, на которую добавляется блок'),
  block_code: z.string().describe(
    'Символьный код блока из репозитория. Примеры, работающие в базе знаний: ' +
    '"27.one_col_fix_title_and_text_2" (текст с заголовком), "27.3.one_col_fix_title" (заголовок), ' +
    '"27.5.one_col_fix_text_with_border" (текст в рамке), "68.1.faq" (раскрывающиеся пункты), ' +
    '"08.1.three_cols_fix_title_and_text" (текст в 3 колонки)'
  ),
  after_block_id: z.union([z.string(), z.number()]).optional().describe(
    'ID блока, после которого вставить новый. Если не указан, блок встанет в начало страницы'
  ),
  content: z.string().optional().describe('Готовый HTML блока вместо стандартного содержимого шаблона'),
  webhook_url: z.string().url().optional(),
});

export async function kbBlockAdd({ page_id, block_code, after_block_id, content, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  const res = await client.call('landing.landing.addblock', {
    scope: KNOWLEDGE_SCOPE,
    lid: page_id,
    fields: {
      CODE: block_code,
      ACTIVE: 'Y',
      ...(after_block_id ? { AFTER_ID: after_block_id } : {}),
      ...(content ? { CONTENT: content } : {}),
    },
  });

  return { portal: client.portal, page_id, block_id: res.result, success: true };
}

export const kbBlockUpdateSchema = z.object({
  page_id: z.union([z.string(), z.number()]).describe('ID страницы'),
  block_id: z.union([z.string(), z.number()]).describe(
    'ID блока в ЧЕРНОВИКЕ страницы. Берётся из b24_kb_page_get без параметра published'
  ),
  nodes: z.record(z.any()).describe(
    'Значения нод в виде { селектор: значение }. Строка — для текста, ' +
    '{ "src": "...", "alt": "..." } — для картинки, { "text": "...", "href": "...", "target": "_blank" } — для ссылки. ' +
    'ВАЖНО: массив значений Bitrix24 молча игнорирует — вернёт result: true, а контент не изменится. ' +
    'Каждую карточку задавайте отдельным селектором с индексом: ".landing-block-card-title@0", ".landing-block-card-title@1". ' +
    'Готовые селекторы даёт b24_kb_page_get с detail="nodes"'
  ),
  webhook_url: z.string().url().optional(),
});

export async function kbBlockUpdate({ page_id, block_id, nodes, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  const res = await client.call('landing.block.updatenodes', {
    scope: KNOWLEDGE_SCOPE,
    lid: page_id,
    block: block_id,
    data: nodes,
  });

  return {
    portal: client.portal,
    page_id,
    block_id,
    updated_selectors: Object.keys(nodes ?? {}),
    success: res.result === true,
    // Правка ушла в черновик: чтобы её увидели читатели, нужен b24_kb_page_publish.
    note: 'Изменения сохранены в черновике. Опубликуйте страницу через b24_kb_page_publish.',
  };
}

export const kbBlockDeleteSchema = z.object({
  page_id: z.union([z.string(), z.number()]).describe('ID страницы'),
  block_id: z.union([z.string(), z.number()]).describe('ID блока в ЧЕРНОВИКЕ страницы'),
  webhook_url: z.string().url().optional(),
});

export async function kbBlockDelete({ page_id, block_id, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  const res = await client.call('landing.landing.deleteblock', {
    scope: KNOWLEDGE_SCOPE,
    lid: page_id,
    block: block_id,
  });

  return { portal: client.portal, page_id, block_id, success: res.result === true };
}

// ─── КАРТОЧКИ ВНУТРИ БЛОКА ────────────────────────────────────────────────────

export const kbCardAddSchema = z.object({
  page_id: z.union([z.string(), z.number()]).describe('ID страницы'),
  block_id: z.union([z.string(), z.number()]).describe('ID блока в ЧЕРНОВИКЕ страницы'),
  selector: z.string().describe(
    'Селектор карточки из манифеста блока с индексом образца. Пример: ".landing-block-card@0". ' +
    'Список селекторов и текущее количество карточек даёт b24_kb_page_get с detail="nodes"'
  ),
  content: z.string().optional().describe(
    'HTML новой карточки. Если не указан, карточка из selector клонируется — обычный сценарий: ' +
    'склонировать и наполнить через b24_kb_block_update по индексу новой карточки'
  ),
  webhook_url: z.string().url().optional(),
});

export async function kbCardAdd({ page_id, block_id, selector, content, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  const res = await client.call('landing.block.addcard', {
    scope: KNOWLEDGE_SCOPE,
    lid: page_id,
    block: block_id,
    selector,
    content: content ?? '',
  });

  return { portal: client.portal, page_id, block_id, selector, success: res.result === true };
}

export const kbCardRemoveSchema = z.object({
  page_id: z.union([z.string(), z.number()]).describe('ID страницы'),
  block_id: z.union([z.string(), z.number()]).describe('ID блока в ЧЕРНОВИКЕ страницы'),
  selector: z.string().describe(
    'Селектор удаляемой карточки с обязательным индексом. Пример: ".landing-block-card@3". ' +
    'После удаления индексы оставшихся карточек сдвигаются, поэтому несколько карточек удобнее удалять с конца'
  ),
  webhook_url: z.string().url().optional(),
});

export async function kbCardRemove({ page_id, block_id, selector, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  const res = await client.call('landing.block.removecard', {
    scope: KNOWLEDGE_SCOPE,
    lid: page_id,
    block: block_id,
    selector,
  });

  return { portal: client.portal, page_id, block_id, selector, success: res.result === true };
}

// ─── КАРТИНКИ ─────────────────────────────────────────────────────────────────

export const kbImageUploadSchema = z.object({
  block_id: z.union([z.string(), z.number()]).describe('ID блока, к которому привязывается картинка'),
  image_url: z.string().url().optional().describe(
    'Публичная ссылка на картинку. Альтернатива паре file_name + content_base64'
  ),
  file_name: z.string().optional().describe('Имя файла с расширением. Пример: "shema.png"'),
  content_base64: z.string().optional().describe('Содержимое картинки в Base64'),
  width: z.number().int().positive().optional().describe('Целевая ширина в пикселях'),
  height: z.number().int().positive().optional().describe('Целевая высота в пикселях'),
  webhook_url: z.string().url().optional(),
});

export async function kbImageUpload({ block_id, image_url, file_name, content_base64, width, height, webhook_url }) {
  if (!image_url && !(file_name && content_base64)) {
    throw new Error('Укажите либо image_url, либо пару file_name + content_base64.');
  }

  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  const res = await client.call('landing.block.uploadfile', {
    scope: KNOWLEDGE_SCOPE,
    block: block_id,
    picture: image_url ? image_url : [file_name, content_base64],
    ...(width || height ? { params: { ...(width ? { width } : {}), ...(height ? { height } : {}) } } : {}),
  });

  return {
    portal: client.portal,
    block_id,
    file: res.result,
    // Загрузка только кладёт файл: путь из file.src нужно прописать в ноду картинки.
    note: 'Пропишите полученный src в ноду блока через b24_kb_block_update: { "<селектор>": { "src": "<src>", "alt": "..." } }.',
    success: true,
  };
}

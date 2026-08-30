import { z } from 'zod';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';
import { toIdList, toObject } from '../utils/php-serialize.js';

// Шаблоны задач — НАСТОЯЩИЕ шаблоны Битрикса (`tasks.template.*`), а не выдумка
// MCP: созданное здесь видно в интерфейсе портала (Задачи → Шаблоны) и работает с
// автоповтором. Инструменты обходят три особенности облачной сборки:
//
//   1. `tasks.template.list` на портале СЛОМАН — при любых параметрах отвечает
//      «Unknown field definition `filter` … for Template Entity». Поэтому список
//      собирается перебором ID через `batch` (см. scanTemplates); нативный вызов
//      всё равно пробуется первым — если Битрикс его починит, он подхватится сам.
//   2. Поля TAGS и XML_ID шаблона REST молча игнорирует (в карте
//      `tasks.template.fields` их нет): update вернёт true, а значение не
//      сохранится. Теги поэтому хранятся строкой-маркером в конце DESCRIPTION,
//      а на задачу вешаются уже настоящими тегами при создании из шаблона.
//   3. Чек-лист шаблона живёт отдельными методами `tasks.template.checklist.*`
//      с параметрами templateId + checkListItemId (НЕ itemId), а поле CHECKLIST
//      в `tasks.task.add` молча игнорируется — пункты добавляются отдельно.
//
// Отдельная ловушка: у шаблонов СВОЙ набор пользовательских полей (сущность
// TASKS_TASK_TEMPLATE), не совпадающий с полями задач (TASKS_TASK). Проверено на
// портале: `tasks.template.fields` отдаёт UF_AUTO_429532694364, которого нет в
// `task.item.userfield.getlist`, и наоборот — UF_MAIL_MESSAGE есть только у задач.
// Значение неизвестного сущности UF портал молча выбрасывает, поэтому коды
// сверяются со списком полей ДО записи, а не после.

const TAG_MARKER = '[MCP_TAGS]:';
const TAG_LINE_RE = /^\[MCP_TAGS\]:[ \t]*(.*)$/im;

// Префиксы кодов привязки CRM в UF_CRM_TASK. Проверено на портале: сохраняются
// и возвращаются как есть.
const CRM_PREFIXES = {
  leads: 'L',
  deals: 'D',
  contacts: 'C',
  companies: 'CO',
  quotes: 'T',
};

const DEFAULT_SCAN_MAX_ID = 500;
const DEFAULT_SCAN_GAP = 100;
const BATCH_SIZE = 50; // жёсткий предел batch в Bitrix24

// ─── Теги: маркер в описании ──────────────────────────────────────────────────

export function extractTags(description) {
  const text = description ?? '';
  const match = text.match(TAG_LINE_RE);
  if (!match) return { description: text, tags: [] };
  const tags = match[1].split(',').map(t => t.trim()).filter(Boolean);
  return { description: text.replace(TAG_LINE_RE, '').replace(/\s+$/, ''), tags };
}

export function embedTags(description, tags) {
  const base = (description ?? '').replace(TAG_LINE_RE, '').replace(/\s+$/, '');
  if (!tags || tags.length === 0) return base;
  return `${base}${base ? '\n\n' : ''}${TAG_MARKER} ${tags.join(', ')}`;
}

// ─── Нормализация ─────────────────────────────────────────────────────────────

function yn(value) {
  return value === true || value === 'Y' ? 'Y' : 'N';
}

function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function userFieldsOf(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('UF_') && key !== 'UF_CRM_TASK') out[key] = value;
  }
  return out;
}

export function normalizeTemplate(raw) {
  const { description, tags } = extractTags(raw.DESCRIPTION ?? '');
  return {
    id: num(raw.ID),
    title: raw.TITLE ?? '',
    description,
    tags,
    priority: num(raw.PRIORITY, 1),
    created_by: num(raw.CREATED_BY),
    created_by_name: [raw.CREATED_BY_NAME, raw.CREATED_BY_LAST_NAME].filter(Boolean).join(' ') || null,
    responsible_id: num(raw.RESPONSIBLE_ID),
    responsible_name: [raw.RESPONSIBLE_NAME, raw.RESPONSIBLE_LAST_NAME].filter(Boolean).join(' ') || null,
    accomplices: toIdList(raw.ACCOMPLICES),
    auditors: toIdList(raw.AUDITORS),
    group_id: num(raw.GROUP_ID, 0),
    parent_id: num(raw.PARENT_ID, 0),
    deadline_after: num(raw.DEADLINE_AFTER),
    start_date_plan_after: num(raw.START_DATE_PLAN_AFTER),
    end_date_plan_after: num(raw.END_DATE_PLAN_AFTER),
    time_estimate: num(raw.TIME_ESTIMATE, 0),
    task_control: raw.TASK_CONTROL === 'Y',
    allow_change_deadline: raw.ALLOW_CHANGE_DEADLINE === 'Y',
    allow_time_tracking: raw.ALLOW_TIME_TRACKING === 'Y',
    add_in_report: raw.ADD_IN_REPORT === 'Y',
    match_work_time: raw.MATCH_WORK_TIME === 'Y',
    multitask: raw.MULTITASK === 'Y',
    replicate: raw.REPLICATE === 'Y',
    replicate_params: toObject(raw.REPLICATE_PARAMS),
    crm: Array.isArray(raw.UF_CRM_TASK) ? raw.UF_CRM_TASK : [],
    user_fields: userFieldsOf(raw),
  };
}

function normalizeChecklistItem(item) {
  return {
    id: num(item.id),
    parent_id: num(item.parentId, 0),
    title: item.title ?? '',
    sort_index: num(item.sortIndex, 0),
    is_important: item.isImportant === true || item.isImportant === 'Y',
    is_complete: item.isComplete === true || item.isComplete === 'Y',
  };
}

// ─── CRM-привязки ─────────────────────────────────────────────────────────────

// Допускаем как удобный объект ({ deals: [1833] }), так и сырые коды
// («D_1833»), потому что типов SPA больше, чем перечислено в CRM_PREFIXES.
const RAW_CRM_CODE_RE = /^[A-Za-z]+(_\d+)?_\d+$/;

export function buildCrmCodes({ crm, crm_bindings } = {}) {
  const codes = [];
  if (crm) {
    for (const [key, prefix] of Object.entries(CRM_PREFIXES)) {
      for (const id of crm[key] ?? []) {
        const n = Number(id);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`Некорректный ID в crm.${key}: ${id}`);
        codes.push(`${prefix}_${n}`);
      }
    }
  }
  for (const code of crm_bindings ?? []) {
    if (!RAW_CRM_CODE_RE.test(code)) {
      throw new Error(
        `Некорректный код CRM-привязки «${code}». Ожидается вид L_1179 (лид), D_1833 (сделка), ` +
        'C_1 (контакт), CO_1 (компания), T_1 (предложение) или DYNAMIC_1040_5 (SPA).'
      );
    }
    codes.push(code);
  }
  return [...new Set(codes)];
}

// ─── Работа с порталом ────────────────────────────────────────────────────────

async function batchCall(client, cmd) {
  const response = await client.call('batch', { halt: 0, cmd });
  return {
    result: response.result?.result ?? {},
    errors: response.result?.result_error ?? {},
  };
}

// Проверяем, что переданные постановщик/исполнитель/соисполнители существуют:
// на несуществующий ID портал либо отвечает невнятно, либо создаёт шаблон,
// у которого потом некому выполнять задачу.
async function assertUsersExist(client, ids) {
  const unique = [...new Set(ids.filter(id => Number.isFinite(id) && id > 0))];
  if (unique.length === 0) return;

  const cmd = {};
  for (const id of unique) cmd[`u${id}`] = `user.get?ID=${id}`;
  const { result } = await batchCall(client, cmd);

  const missing = unique.filter(id => {
    const entry = result[`u${id}`];
    return !(Array.isArray(entry) && entry.length > 0);
  });
  if (missing.length) {
    throw new Error(
      `Пользователи не найдены на портале: ${missing.join(', ')}. ` +
      'Проверьте ID через b24_users_list.'
    );
  }
}

// Обход сломанного `tasks.template.list`: перебираем ID пачками по 50 через
// batch. Отсутствующий шаблон приходит как false, ошибки не возникает. Скан
// останавливается после `gap` подряд пустых ID или на `maxId`.
export async function scanTemplates(client, { maxId = DEFAULT_SCAN_MAX_ID, gap = DEFAULT_SCAN_GAP } = {}) {
  const found = [];
  let misses = 0;
  let lastId = 0;

  for (let start = 1; start <= maxId; start += BATCH_SIZE) {
    const ids = [];
    const cmd = {};
    for (let id = start; id < start + BATCH_SIZE && id <= maxId; id++) {
      ids.push(id);
      cmd[`t${id}`] = `tasks.template.get?templateId=${id}`;
    }

    const { result } = await batchCall(client, cmd);
    for (const id of ids) {
      lastId = id;
      const item = result[`t${id}`];
      if (item && item.ID) {
        found.push(item);
        misses = 0;
      } else {
        misses += 1;
      }
    }
    if (misses >= gap) break;
  }

  return { templates: found, scanned_to: lastId, stopped_early: misses >= gap };
}

// Нативный список пробуем первым — вдруг портал уже починен. Форма ответа
// заранее неизвестна, поэтому принимаем и массив, и { templates: [...] }, а на
// любой неожиданности честно откатываемся на скан.
async function nativeList(client) {
  try {
    const response = await client.call('tasks.template.list', {});
    const raw = response.result?.templates ?? response.result;
    const items = Array.isArray(raw) ? raw : Object.values(raw ?? {});
    if (!items.length || !items.every(item => item && item.ID)) return null;
    return items;
  } catch {
    return null;
  }
}

// Коды пользовательских полей, которые сущность реально знает. Значение поля,
// которого у сущности нет, портал принимает и выбрасывает без единого слова.
async function templateUserFieldCodes(client) {
  const response = await client.call('tasks.template.fields', {});
  return Object.keys(response.result ?? {}).filter(key => key.startsWith('UF_'));
}

async function taskUserFieldCodes(client) {
  const response = await client.call('tasks.task.getFields', {});
  return Object.keys(response.result?.fields ?? {}).filter(key => key.startsWith('UF_'));
}

async function assertTemplateUserFields(client, userFields) {
  const keys = Object.keys(userFields ?? {});
  if (keys.length === 0) return;

  const available = await templateUserFieldCodes(client);
  const unknown = keys.filter(key => !available.includes(key));
  if (unknown.length) {
    throw new Error(
      `Шаблоны задач не знают полей: ${unknown.join(', ')}. ` +
      `У шаблонов свой набор пользовательских полей (сущность TASKS_TASK_TEMPLATE), ` +
      `отличный от полей задач. Доступны: ${available.join(', ') || '—'}. ` +
      'Новое поле шаблона через REST создать нельзя — только в интерфейсе портала. ' +
      'Поля, созданные через b24_task_userfield_create, принадлежат ЗАДАЧАМ: передавайте их ' +
      'в user_fields инструмента b24_task_create_from_template.'
    );
  }
}

async function fetchChecklist(client, templateId) {
  const response = await client.call('tasks.template.checklist.list', { templateId });
  const raw = response.result?.checkListItems ?? {};
  const items = Array.isArray(raw) ? raw : Object.values(raw);
  return items.map(normalizeChecklistItem).sort((a, b) => a.sort_index - b.sort_index);
}

async function getTemplate(client, templateId, { withChecklist = true } = {}) {
  const response = await client.call('tasks.template.get', { templateId });
  const raw = response.result;
  if (!raw || !raw.ID) {
    throw new Error(`Шаблон ${templateId} не найден или недоступен этому вебхуку.`);
  }
  const template = normalizeTemplate(raw);
  if (withChecklist) template.checklist = await fetchChecklist(client, templateId);
  return template;
}

async function addChecklistItems(client, target, items) {
  const method = target.templateId ? 'tasks.template.checklist.add' : 'tasks.task.checklist.add';
  const created = [];
  let sort = 0;
  for (const item of items) {
    const response = await client.call(method, {
      ...target,
      fields: {
        TITLE: item.title,
        PARENT_ID: 0,
        SORT_INDEX: sort,
        IS_IMPORTANT: yn(item.is_important),
      },
    });
    const added = response.result?.checkListItem;
    if (added) created.push(normalizeChecklistItem(added));
    sort += 1;
  }
  return created;
}

// Чек-лист шаблона: полная замена.
async function replaceChecklist(client, templateId, items) {
  const existing = await fetchChecklist(client, templateId);
  for (const item of existing) {
    await client.call('tasks.template.checklist.delete', { templateId, checkListItemId: item.id });
  }
  return addChecklistItems(client, { templateId }, items);
}

// Сборка полей шаблона для tasks.template.add / update. В fields попадают только
// те ключи, которые вызывающий действительно передал, — update частичный.
function buildTemplateFields(input, { description, tags }) {
  const fields = {};
  const put = (key, value) => {
    if (value !== undefined) fields[key] = value;
  };

  put('TITLE', input.title);
  if (description !== undefined) fields.DESCRIPTION = embedTags(description, tags);
  put('RESPONSIBLE_ID', input.responsible_id);
  put('CREATED_BY', input.created_by);
  put('ACCOMPLICES', input.accomplices);
  put('AUDITORS', input.auditors);
  put('GROUP_ID', input.group_id);
  put('PARENT_ID', input.parent_id);
  put('PRIORITY', input.priority);
  put('DEADLINE_AFTER', input.deadline_after);
  put('START_DATE_PLAN_AFTER', input.start_date_plan_after);
  put('END_DATE_PLAN_AFTER', input.end_date_plan_after);
  put('TIME_ESTIMATE', input.time_estimate);
  if (input.task_control !== undefined) fields.TASK_CONTROL = yn(input.task_control);
  if (input.allow_change_deadline !== undefined) fields.ALLOW_CHANGE_DEADLINE = yn(input.allow_change_deadline);
  if (input.allow_time_tracking !== undefined) fields.ALLOW_TIME_TRACKING = yn(input.allow_time_tracking);
  if (input.add_in_report !== undefined) fields.ADD_IN_REPORT = yn(input.add_in_report);
  if (input.match_work_time !== undefined) fields.MATCH_WORK_TIME = yn(input.match_work_time);
  if (input.multitask !== undefined) fields.MULTITASK = yn(input.multitask);
  if (input.replicate !== undefined) fields.REPLICATE = yn(input.replicate);
  put('REPLICATE_PARAMS', input.replicate_params);

  const crmCodes = buildCrmCodes(input);
  if (crmCodes.length || input.crm !== undefined || input.crm_bindings !== undefined) {
    fields.UF_CRM_TASK = crmCodes;
  }
  Object.assign(fields, input.user_fields ?? {});

  return fields;
}

function normalizeTitle(title) {
  return (title ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Часть полей портал принимает и игнорирует. Молчать об этом нельзя — модель
// решит, что значение сохранено.
function templateWarnings(input, template) {
  const warnings = [];
  if (input.tags?.length && template.tags.length === 0) {
    warnings.push('Теги не удалось сохранить в описании шаблона.');
  }
  const missingCrm = buildCrmCodes(input).filter(code => !template.crm.includes(code));
  if (missingCrm.length) {
    warnings.push(`Портал не сохранил CRM-привязки: ${missingCrm.join(', ')}.`);
  }
  for (const key of Object.keys(input.user_fields ?? {})) {
    const stored = template.user_fields[key];
    if (stored === undefined || stored === null || stored === false) {
      warnings.push(`Портал не сохранил пользовательское поле ${key}.`);
    }
  }
  return warnings;
}

// ─── Общие куски схем ─────────────────────────────────────────────────────────

const idParam = z.union([z.string(), z.number()]);

const crmParam = z.object({
  leads: z.array(idParam).optional().describe('ID лидов'),
  deals: z.array(idParam).optional().describe('ID сделок'),
  contacts: z.array(idParam).optional().describe('ID контактов'),
  companies: z.array(idParam).optional().describe('ID компаний'),
  quotes: z.array(idParam).optional().describe('ID предложений'),
}).describe('Привязка к CRM в удобном виде; кладётся в UF_CRM_TASK');

const checklistParam = z.array(z.object({
  title: z.string().min(1).describe('Текст пункта'),
  is_important: z.boolean().optional().describe('Пометить пункт важным'),
})).describe('Чек-лист. Хранится отдельными методами tasks.template.checklist.*');

// У шаблона и у задачи наборы пользовательских полей РАЗНЫЕ, поэтому и подсказки
// в схемах разные — иначе модель уверенно передаёт код не в тот инструмент.
const templateUserFieldsParam = z.record(z.any()).describe(
  'Пользовательские поля ШАБЛОНА: { "UF_AUTO_429532694364": 12.5 }. Набор отличается от ' +
  'полей задачи и создаётся только в интерфейсе портала; доступные коды показывает ' +
  'b24_task_userfield_list с with_template_fields: true'
);

const taskUserFieldsParam = z.record(z.any()).describe(
  'Пользовательские поля ЗАДАЧИ: { "UF_TASK_BUDGET": 12.5 }. ' +
  'Список доступных полей — b24_task_userfield_list, создание — b24_task_userfield_create'
);

// ─── CREATE ───────────────────────────────────────────────────────────────────

export const taskTemplateCreateSchema = z.object({
  title: z.string().min(1).max(255).describe('Название шаблона (обязательно)'),
  description: z.string().optional().describe('Описание. Поддерживает BBCode'),
  responsible_id: idParam.describe('ID исполнителя (обязательно)'),
  created_by: idParam.optional().describe(
    'ID постановщика. По умолчанию — владелец вебхука, от чьего имени идёт вызов'
  ),
  accomplices: z.array(idParam).optional().describe('ID соисполнителей'),
  auditors: z.array(idParam).optional().describe('ID наблюдателей'),
  group_id: idParam.optional().describe('ID проекта/группы'),
  parent_id: idParam.optional().describe('ID родительской задачи'),
  priority: z.number().int().min(0).max(2).optional().describe('0=низкий, 1=обычный, 2=высокий'),
  deadline_after: z.number().int().min(0).optional().describe(
    'Крайний срок: смещение в СЕКУНДАХ от момента создания задачи (86400 = сутки)'
  ),
  start_date_plan_after: z.number().int().min(0).optional().describe('Плановый старт: смещение в секундах'),
  end_date_plan_after: z.number().int().min(0).optional().describe('Плановое завершение: смещение в секундах'),
  time_estimate: z.number().int().min(0).optional().describe('Оценка времени в секундах'),
  task_control: z.boolean().optional().describe('Принимать работу'),
  allow_change_deadline: z.boolean().optional().describe('Разрешить исполнителю менять срок'),
  allow_time_tracking: z.boolean().optional().describe('Учёт времени'),
  add_in_report: z.boolean().optional().describe('Добавлять в отчёт'),
  match_work_time: z.boolean().optional().describe('Пропускать выходные'),
  multitask: z.boolean().optional().describe('Множественная задача'),
  replicate: z.boolean().optional().describe('Повторяющаяся задача (нужен replicate_params)'),
  replicate_params: z.record(z.any()).optional().describe(
    'Параметры повтора: { "PERIOD": "weekly", "EVERY_WEEK": 1, "WEEK_DAYS": [2], ' +
    '"TIME": "11:00", "REPEAT_TILL": "endless", "START_DATE": "16.03.2026 00:00:00" }'
  ),
  tags: z.array(z.string().min(1)).optional().describe(
    'Теги. REST не сохраняет TAGS у шаблона, поэтому они хранятся строкой ' +
    '"[MCP_TAGS]: …" в конце описания и вешаются на задачу при создании из шаблона'
  ),
  crm: crmParam.optional(),
  crm_bindings: z.array(z.string()).optional().describe('Сырые коды привязки CRM: ["D_1833", "L_1179"]'),
  user_fields: templateUserFieldsParam.optional(),
  checklist: checklistParam.optional(),
  allow_duplicate: z.boolean().optional().default(false).describe(
    'По умолчанию шаблон с таким же названием (у того же постановщика и проекта) ' +
    'не создаётся повторно — возвращается существующий. true снимает защиту'
  ),
  webhook_url: z.string().url().optional(),
});

export async function taskTemplateCreate(input) {
  const client = new Bitrix24Client(resolveWebhook(input.webhook_url));

  const responsibleId = Number(input.responsible_id);
  if (!Number.isFinite(responsibleId) || responsibleId <= 0) {
    throw new Error(`Некорректный responsible_id: ${input.responsible_id}`);
  }

  // Постановщик обязателен для tasks.template.add; если не задан — берём
  // владельца вебхука, иначе портал ответит «Could not find value».
  let creatorId = input.created_by !== undefined ? Number(input.created_by) : undefined;
  if (creatorId === undefined) {
    const me = await client.call('profile');
    creatorId = Number(me.result?.ID);
  }
  await assertUsersExist(client, [
    responsibleId,
    creatorId,
    ...(input.accomplices ?? []).map(Number),
    ...(input.auditors ?? []).map(Number),
  ]);
  await assertTemplateUserFields(client, input.user_fields);

  // Защита от дублей: одноимённый шаблон того же постановщика в том же проекте.
  if (!input.allow_duplicate) {
    const { templates } = await scanTemplates(client);
    const wanted = normalizeTitle(input.title);
    const groupId = Number(input.group_id ?? 0);
    const duplicate = templates.find(t =>
      normalizeTitle(t.TITLE) === wanted &&
      Number(t.CREATED_BY) === creatorId &&
      Number(t.GROUP_ID ?? 0) === groupId
    );
    if (duplicate) {
      return {
        portal: client.portal,
        created: false,
        reason: 'duplicate',
        message:
          `Шаблон «${duplicate.TITLE}» (ID ${duplicate.ID}) уже существует у постановщика ${creatorId}. ` +
          'Ничего не создано. Передайте allow_duplicate: true, если дубль нужен намеренно.',
        template: await getTemplate(client, Number(duplicate.ID)),
      };
    }
  }

  const fields = buildTemplateFields(
    { ...input, responsible_id: responsibleId, created_by: creatorId },
    { description: input.description ?? '', tags: input.tags ?? [] }
  );

  const response = await client.call('tasks.template.add', { fields });
  const templateId = Number(response.result);
  if (!Number.isFinite(templateId) || templateId <= 0) {
    throw new Error(
      'Портал не вернул ID шаблона (tasks.template.add отдал 0). ' +
      'Обычно это значит, что не хватило обязательных полей или прав.'
    );
  }

  if (input.checklist?.length) {
    await addChecklistItems(client, { templateId }, input.checklist);
  }

  // Перечитываем: подтверждаем, что портал действительно сохранил поля, а не
  // проглотил их молча (так ведут себя TAGS и XML_ID).
  const template = await getTemplate(client, templateId);
  return {
    portal: client.portal,
    created: true,
    template_id: templateId,
    template,
    warnings: templateWarnings(input, template),
  };
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

export const taskTemplateListSchema = z.object({
  title: z.string().optional().describe('Фильтр по вхождению подстроки в название (без учёта регистра)'),
  responsible_id: idParam.optional().describe('Фильтр по исполнителю'),
  created_by: idParam.optional().describe('Фильтр по постановщику'),
  group_id: idParam.optional().describe('Фильтр по проекту'),
  replicate: z.boolean().optional().describe('true — только повторяющиеся шаблоны'),
  with_checklist: z.boolean().optional().default(false).describe(
    'Дотягивать чек-лист каждого шаблона отдельным запросом (медленнее)'
  ),
  max_id: z.number().int().min(1).max(10000).optional().default(DEFAULT_SCAN_MAX_ID).describe(
    'Верхняя граница перебора ID (нативный list на портале сломан). Поднимите, если шаблонов много'
  ),
  gap: z.number().int().min(10).max(1000).optional().default(DEFAULT_SCAN_GAP).describe(
    'Остановиться после стольких подряд пустых ID'
  ),
  webhook_url: z.string().url().optional(),
});

export async function taskTemplateList(input = {}) {
  const client = new Bitrix24Client(resolveWebhook(input.webhook_url));

  let raws = await nativeList(client);
  let source = 'tasks.template.list';
  let scanInfo = null;

  if (!raws) {
    const scan = await scanTemplates(client, { maxId: input.max_id, gap: input.gap });
    raws = scan.templates;
    source = 'id-scan';
    scanInfo = { scanned_to: scan.scanned_to, stopped_early: scan.stopped_early };
  }

  let templates = raws.map(normalizeTemplate);

  if (input.title) {
    const needle = input.title.trim().toLowerCase();
    templates = templates.filter(t => t.title.toLowerCase().includes(needle));
  }
  if (input.responsible_id !== undefined) {
    templates = templates.filter(t => t.responsible_id === Number(input.responsible_id));
  }
  if (input.created_by !== undefined) {
    templates = templates.filter(t => t.created_by === Number(input.created_by));
  }
  if (input.group_id !== undefined) {
    templates = templates.filter(t => t.group_id === Number(input.group_id));
  }
  if (input.replicate !== undefined) {
    templates = templates.filter(t => t.replicate === input.replicate);
  }

  if (input.with_checklist) {
    for (const template of templates) {
      template.checklist = await fetchChecklist(client, template.id);
    }
  }

  templates.sort((a, b) => a.id - b.id);
  return {
    portal: client.portal,
    source,
    ...(scanInfo ?? {}),
    count: templates.length,
    templates,
  };
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

export const taskTemplateUpdateSchema = z.object({
  template_id: idParam.describe('ID изменяемого шаблона'),
  title: z.string().min(1).max(255).optional(),
  description: z.string().optional().describe('Полностью заменяет описание'),
  responsible_id: idParam.optional(),
  created_by: idParam.optional().describe('ID постановщика'),
  accomplices: z.array(idParam).optional(),
  auditors: z.array(idParam).optional(),
  group_id: idParam.optional(),
  parent_id: idParam.optional(),
  priority: z.number().int().min(0).max(2).optional(),
  deadline_after: z.number().int().min(0).optional().describe('Смещение крайнего срока в секундах'),
  start_date_plan_after: z.number().int().min(0).optional(),
  end_date_plan_after: z.number().int().min(0).optional(),
  time_estimate: z.number().int().min(0).optional(),
  task_control: z.boolean().optional(),
  allow_change_deadline: z.boolean().optional(),
  allow_time_tracking: z.boolean().optional(),
  add_in_report: z.boolean().optional(),
  match_work_time: z.boolean().optional(),
  multitask: z.boolean().optional(),
  replicate: z.boolean().optional(),
  replicate_params: z.record(z.any()).optional(),
  tags: z.array(z.string().min(1)).optional().describe('Заменяет теги целиком (пустой массив — снять все)'),
  crm: crmParam.optional(),
  crm_bindings: z.array(z.string()).optional(),
  user_fields: templateUserFieldsParam.optional(),
  checklist: checklistParam.optional().describe('Если передан — чек-лист заменяется целиком'),
  webhook_url: z.string().url().optional(),
});

export async function taskTemplateUpdate(input) {
  const client = new Bitrix24Client(resolveWebhook(input.webhook_url));
  const templateId = Number(input.template_id);
  if (!Number.isFinite(templateId) || templateId <= 0) {
    throw new Error(`Некорректный template_id: ${input.template_id}`);
  }

  // Читаем текущее состояние: описание и теги лежат в одном поле, поэтому
  // изменение одного не должно затирать другое.
  const current = await getTemplate(client, templateId, { withChecklist: false });

  await assertUsersExist(client, [
    ...(input.responsible_id !== undefined ? [Number(input.responsible_id)] : []),
    ...(input.created_by !== undefined ? [Number(input.created_by)] : []),
    ...(input.accomplices ?? []).map(Number),
    ...(input.auditors ?? []).map(Number),
  ]);
  await assertTemplateUserFields(client, input.user_fields);

  const touchesText = input.description !== undefined || input.tags !== undefined;
  const description = input.description !== undefined ? input.description : current.description;
  const tags = input.tags !== undefined ? input.tags : current.tags;

  const fields = buildTemplateFields(input, {
    description: touchesText ? description : undefined,
    tags,
  });

  if (Object.keys(fields).length === 0 && input.checklist === undefined) {
    throw new Error('Не передано ни одного изменяемого поля.');
  }

  if (Object.keys(fields).length > 0) {
    await client.call('tasks.template.update', { templateId, fields });
  }
  if (input.checklist !== undefined) {
    await replaceChecklist(client, templateId, input.checklist);
  }

  const template = await getTemplate(client, templateId);
  return {
    portal: client.portal,
    updated: true,
    template_id: templateId,
    template,
    warnings: templateWarnings(input, template),
  };
}

// ─── CREATE TASK FROM TEMPLATE ────────────────────────────────────────────────

// Нативного «создай задачу по шаблону» в REST нет (у tasks.task.add нет поля
// TEMPLATE_ID — только флаг FORKED_BY_TEMPLATE_ID), поэтому раскрытие шаблона
// в задачу делает MCP: читает шаблон, переводит смещения в даты и добавляет
// чек-лист отдельными вызовами.
export const taskCreateFromTemplateSchema = z.object({
  template_id: idParam.describe('ID шаблона, по которому создаётся задача'),
  title: z.string().min(1).optional().describe('Переопределить название'),
  description: z.string().optional().describe('Переопределить описание'),
  responsible_id: idParam.optional().describe('Переопределить исполнителя'),
  created_by: idParam.optional().describe('Переопределить постановщика'),
  accomplices: z.array(idParam).optional(),
  auditors: z.array(idParam).optional(),
  group_id: idParam.optional(),
  priority: z.number().int().min(0).max(2).optional(),
  deadline: z.string().optional().describe(
    'Точный крайний срок в ISO8601 ("2026-09-05T18:00:00+03:00"). ' +
    'Без него берётся deadline_after шаблона, отсчитанный от текущего момента'
  ),
  tags: z.array(z.string().min(1)).optional().describe('Заменяет теги шаблона'),
  crm: crmParam.optional().describe('Добавляется к CRM-привязкам шаблона'),
  crm_bindings: z.array(z.string()).optional(),
  user_fields: taskUserFieldsParam.optional(),
  with_checklist: z.boolean().optional().default(true).describe('Переносить чек-лист шаблона в задачу'),
  dedup_window_hours: z.number().int().min(0).max(720).optional().default(24).describe(
    'Не создавать вторую незакрытую задачу с тем же названием и исполнителем, ' +
    'созданную за столько часов. 0 — отключить проверку'
  ),
  allow_duplicate: z.boolean().optional().default(false).describe('Снять защиту от дублей'),
  webhook_url: z.string().url().optional(),
});

function offsetToIso(seconds) {
  return new Date(Date.now() + Number(seconds) * 1000).toISOString();
}

export async function taskCreateFromTemplate(input) {
  const client = new Bitrix24Client(resolveWebhook(input.webhook_url));
  const templateId = Number(input.template_id);
  if (!Number.isFinite(templateId) || templateId <= 0) {
    throw new Error(`Некорректный template_id: ${input.template_id}`);
  }

  const template = await getTemplate(client, templateId);

  const title = input.title ?? template.title;
  const responsibleId = Number(input.responsible_id ?? template.responsible_id);
  const createdBy = Number(input.created_by ?? template.created_by);
  if (!Number.isFinite(responsibleId) || responsibleId <= 0) {
    throw new Error(`У шаблона ${templateId} не задан исполнитель, и он не передан в responsible_id.`);
  }
  await assertUsersExist(client, [
    responsibleId,
    createdBy,
    ...(input.accomplices ?? []).map(Number),
    ...(input.auditors ?? []).map(Number),
  ]);

  // Пользовательские поля шаблона и задачи — РАЗНЫЕ сущности. Сверяем коды до
  // всего остального: кривой ввод должен падать ошибкой, а не превращаться
  // в «уже есть такая задача» на проверке дублей ниже.
  const taskUfCodes = await taskUserFieldCodes(client);
  const unknownUf = Object.keys(input.user_fields ?? {}).filter(key => !taskUfCodes.includes(key));
  if (unknownUf.length) {
    throw new Error(
      `Задачи не знают полей: ${unknownUf.join(', ')}. ` +
      `Доступны: ${taskUfCodes.join(', ') || '—'}. ` +
      'Создать новое поле задач — b24_task_userfield_create. ' +
      'Если это поле шаблона — у шаблонов свой набор, в задачу оно не переносится.'
    );
  }

  // Защита от дублей: незакрытая одноимённая задача того же исполнителя,
  // созданная внутри окна. Статус фильтруем на нашей стороне — у tasks.task.list
  // отрицающие операторы ведут себя неодинаково между сборками.
  const windowHours = input.dedup_window_hours ?? 24;
  if (!input.allow_duplicate && windowHours > 0) {
    const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
    const existing = await client.call('tasks.task.list', {
      filter: { '=TITLE': title, RESPONSIBLE_ID: responsibleId, '>=CREATED_DATE': since },
      select: ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID', 'CREATED_DATE', 'DEADLINE'],
      order: { ID: 'DESC' },
    });
    const open = (existing.result?.tasks ?? []).filter(t => Number(t.status ?? t.STATUS) !== 5);
    if (open.length > 0) {
      return {
        portal: client.portal,
        created: false,
        reason: 'duplicate',
        message:
          `Задача «${title}» на исполнителя ${responsibleId} уже создана за последние ${windowHours} ч ` +
          `(ID ${open[0].id ?? open[0].ID}) и не закрыта. Ничего не создано. ` +
          'Передайте allow_duplicate: true или dedup_window_hours: 0, если дубль нужен.',
        from_template_id: templateId,
        existing_task: open[0],
      };
    }
  }

  const fields = {
    TITLE: title,
    DESCRIPTION: input.description ?? template.description,
    RESPONSIBLE_ID: responsibleId,
    CREATED_BY: createdBy,
    PRIORITY: input.priority ?? template.priority,
  };

  const accomplices = input.accomplices ?? template.accomplices;
  const auditors = input.auditors ?? template.auditors;
  if (accomplices.length) fields.ACCOMPLICES = accomplices.map(Number);
  if (auditors.length) fields.AUDITORS = auditors.map(Number);

  const groupId = Number(input.group_id ?? template.group_id ?? 0);
  if (groupId > 0) fields.GROUP_ID = groupId;
  if (template.parent_id > 0) fields.PARENT_ID = template.parent_id;
  if (template.time_estimate > 0) fields.TIME_ESTIMATE = template.time_estimate;
  if (template.task_control) fields.TASK_CONTROL = 'Y';
  if (template.allow_change_deadline) fields.ALLOW_CHANGE_DEADLINE = 'Y';
  if (template.allow_time_tracking) fields.ALLOW_TIME_TRACKING = 'Y';
  if (template.add_in_report) fields.ADD_IN_REPORT = 'Y';
  if (template.match_work_time) fields.MATCH_WORK_TIME = 'Y';

  // Шаблон хранит СМЕЩЕНИЯ в секундах, задача — конкретные даты.
  if (input.deadline) {
    fields.DEADLINE = input.deadline;
  } else if (template.deadline_after !== null && template.deadline_after > 0) {
    fields.DEADLINE = offsetToIso(template.deadline_after);
  }
  if (template.start_date_plan_after !== null && template.start_date_plan_after > 0) {
    fields.START_DATE_PLAN = offsetToIso(template.start_date_plan_after);
  }
  if (template.end_date_plan_after !== null && template.end_date_plan_after > 0) {
    fields.END_DATE_PLAN = offsetToIso(template.end_date_plan_after);
  }

  const tags = input.tags ?? template.tags;
  if (tags.length) fields.TAGS = tags;

  const crmCodes = [...new Set([...template.crm, ...buildCrmCodes(input)])];
  if (crmCodes.length) fields.UF_CRM_TASK = crmCodes;

  // Переносим только те коды, которые задача действительно знает, а остальное
  // называем вслух: молча потерянное значение хуже отсутствующего.
  const carriedUf = {};
  const droppedUf = [];
  for (const [key, value] of Object.entries(template.user_fields)) {
    if (value === null || value === false) continue;
    if (taskUfCodes.includes(key)) carriedUf[key] = value;
    else droppedUf.push(key);
  }
  Object.assign(fields, carriedUf, input.user_fields ?? {});

  const response = await client.call('tasks.task.add', { fields });
  const taskId = Number(response.result?.task?.id);
  if (!Number.isFinite(taskId) || taskId <= 0) {
    throw new Error('Портал не вернул ID созданной задачи.');
  }

  // CHECKLIST в tasks.task.add молча игнорируется — пункты добавляем отдельно.
  const checklistSource = input.with_checklist === false ? [] : (template.checklist ?? []);
  if (checklistSource.length) {
    await addChecklistItems(client, { taskId }, checklistSource);
  }

  // Повторное чтение созданной задачи — подтверждаем, что теги, CRM-привязки и
  // пользовательские поля действительно на месте.
  const reread = await client.call('tasks.task.get', {
    taskId,
    select: [
      'ID', 'TITLE', 'DESCRIPTION', 'STATUS', 'PRIORITY', 'RESPONSIBLE_ID', 'CREATED_BY',
      'ACCOMPLICES', 'AUDITORS', 'GROUP_ID', 'DEADLINE', 'START_DATE_PLAN', 'END_DATE_PLAN',
      'TIME_ESTIMATE', 'TAGS', 'CHECKLIST', 'UF_CRM_TASK',
    ],
  });
  const task = reread.result?.task ?? null;

  const warnings = [];
  if (tags.length && task && Object.keys(task.tags ?? {}).length === 0) {
    warnings.push('Теги не появились в задаче — проверьте права вебхука.');
  }
  if (droppedUf.length) {
    warnings.push(
      `Поля шаблона ${droppedUf.join(', ')} не перенесены: у задач таких полей нет ` +
      '(у шаблонов и задач разные наборы пользовательских полей).'
    );
  }

  return {
    portal: client.portal,
    created: true,
    from_template_id: templateId,
    task_id: taskId,
    task_url: `https://${client.portal}/company/personal/user/${responsibleId}/tasks/task/view/${taskId}/`,
    task,
    checklist_items: checklistSource.length,
    warnings,
  };
}

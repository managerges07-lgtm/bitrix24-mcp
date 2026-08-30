import { z } from 'zod';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';

// Пользовательские поля задач (сущность TASKS_TASK). Живут в устаревшем, но
// единственном рабочем семействе `task.item.userfield.*`: у нового `tasks.task.*`
// методов управления полями нет. Особенности:
//
//   - параметры передаются одним объектом PARAMS (не fields, как везде ещё);
//   - префикс UF_ портал добавит сам, если его забыли;
//   - удаление поля стирает его значения во ВСЕХ задачах — отсюда обязательный
//     confirm у b24_task_userfield_delete;
//   - поле принадлежит ТОЛЬКО задачам. У шаблонов задач своя сущность
//     (TASKS_TASK_TEMPLATE) со своим набором полей, и создать поле там через REST
//     нельзя — только в интерфейсе портала. Проверено: созданное здесь поле не
//     появляется в `tasks.template.fields`, а значение, переданное в шаблон,
//     портал молча выбрасывает. Поэтому список полей шаблона показывается рядом
//     (with_template_fields) — чтобы коды не путали между собой.

const FIELD_NAME_RE = /^[A-Za-z0-9_]+$/;

const USER_TYPES = [
  'string', 'integer', 'double', 'boolean', 'enumeration', 'datetime', 'date',
  'money', 'url', 'address', 'file', 'employee', 'crm_status', 'iblock_section',
  'iblock_element', 'crm',
];

function normalizeField(raw) {
  return {
    id: Number(raw.ID),
    field_name: raw.FIELD_NAME,
    type: raw.USER_TYPE_ID,
    label: raw.EDIT_FORM_LABEL ?? raw.LIST_COLUMN_LABEL ?? null,
    multiple: raw.MULTIPLE === 'Y',
    mandatory: raw.MANDATORY === 'Y',
    sort: Number(raw.SORT ?? 100),
    xml_id: raw.XML_ID || null,
    settings: raw.SETTINGS ?? null,
  };
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

export const taskUserfieldListSchema = z.object({
  with_types: z.boolean().optional().default(false).describe(
    'Дополнительно вернуть справочник доступных типов полей'
  ),
  with_template_fields: z.boolean().optional().default(false).describe(
    'Дополнительно вернуть коды пользовательских полей ШАБЛОНОВ задач — это другой набор, ' +
    'и именно его принимает user_fields у b24_task_template_create/update'
  ),
  webhook_url: z.string().url().optional(),
});

export async function taskUserfieldList({ with_types = false, with_template_fields = false, webhook_url } = {}) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  const response = await client.call('task.item.userfield.getlist', {});
  const raw = response.result ?? [];
  const items = Array.isArray(raw) ? raw : Object.values(raw);

  const result = {
    portal: client.portal,
    entity_id: 'TASKS_TASK',
    count: items.length,
    fields: items.map(normalizeField),
  };

  if (with_types) {
    const types = await client.call('task.item.userfield.gettypes', {});
    result.available_types = (types.result ?? []).map(t => ({ id: t.ID, title: t.title }));
  }

  if (with_template_fields) {
    const templateFields = await client.call('tasks.template.fields', {});
    result.template_fields = Object.entries(templateFields.result ?? {})
      .filter(([code]) => code.startsWith('UF_'))
      .map(([code, meta]) => ({ field_name: code, type: meta.type, label: meta.title ?? null }));
    result.template_fields_note =
      'Это поля сущности TASKS_TASK_TEMPLATE. Создать новое поле шаблона через REST нельзя — ' +
      'только в интерфейсе портала.';
  }

  return result;
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

export const taskUserfieldCreateSchema = z.object({
  field_name: z.string().min(1).describe(
    'Код поля, например "UF_TASK_BUDGET". Префикс UF_ подставляется автоматически, если его нет'
  ),
  type: z.enum(USER_TYPES).describe(
    'Тип поля: string, integer, double, boolean, enumeration, datetime, date, money, ' +
    'url, address, file, employee, crm_status, iblock_section, iblock_element, crm'
  ),
  label: z.string().optional().describe('Подпись поля в карточке задачи'),
  multiple: z.boolean().optional().default(false).describe('Множественное значение'),
  mandatory: z.boolean().optional().default(false).describe('Обязательное поле'),
  sort: z.number().int().optional().describe('Порядок сортировки (по умолчанию 100)'),
  xml_id: z.string().optional().describe('Внешний идентификатор'),
  settings: z.record(z.any()).optional().describe(
    'Доп. настройки типа: { "DEFAULT_VALUE": "…", "ROWS": 10 }'
  ),
  list_values: z.array(z.string().min(1)).optional().describe(
    'Значения для type="enumeration" — варианты списка'
  ),
  webhook_url: z.string().url().optional(),
});

export async function taskUserfieldCreate(input) {
  const client = new Bitrix24Client(resolveWebhook(input.webhook_url));

  const bare = input.field_name.trim();
  if (!FIELD_NAME_RE.test(bare)) {
    throw new Error(
      `Некорректный код поля «${bare}»: допустимы только латиница, цифры и подчёркивание.`
    );
  }
  const fieldName = bare.toUpperCase().startsWith('UF_') ? bare.toUpperCase() : `UF_${bare.toUpperCase()}`;

  if (input.type === 'enumeration' && !input.list_values?.length) {
    throw new Error('Для type="enumeration" нужно передать list_values — иначе список будет пустым.');
  }

  // Защита от дублей: портал на повторный код отвечает ERROR_CORE «Поле … уже
  // существует», но понятнее вернуть существующее поле, чем ошибку.
  const existing = await taskUserfieldList({ webhook_url: input.webhook_url });
  const duplicate = existing.fields.find(f => f.field_name === fieldName);
  if (duplicate) {
    return {
      portal: client.portal,
      created: false,
      reason: 'duplicate',
      message: `Поле ${fieldName} уже существует (ID ${duplicate.id}). Ничего не создано.`,
      field: duplicate,
    };
  }

  const params = {
    FIELD_NAME: fieldName,
    USER_TYPE_ID: input.type,
    MULTIPLE: input.multiple ? 'Y' : 'N',
    MANDATORY: input.mandatory ? 'Y' : 'N',
  };
  if (input.label !== undefined) {
    params.LABEL = input.label;
    params.EDIT_FORM_LABEL = { ru: input.label, en: input.label };
  }
  if (input.sort !== undefined) params.SORT = input.sort;
  if (input.xml_id !== undefined) params.XML_ID = input.xml_id;
  if (input.settings !== undefined) params.SETTINGS = input.settings;
  if (input.list_values?.length) {
    params.LIST = input.list_values.map((value, index) => ({ VALUE: value, SORT: (index + 1) * 10 }));
  }

  const response = await client.call('task.item.userfield.add', { PARAMS: params });
  const fieldId = Number(response.result);
  if (!Number.isFinite(fieldId) || fieldId <= 0) {
    throw new Error(`Портал не вернул ID созданного поля (ответ: ${JSON.stringify(response.result)}).`);
  }

  // Перечитываем список: подтверждаем, что поле реально появилось у TASKS_TASK.
  const after = await taskUserfieldList({ webhook_url: input.webhook_url });
  const field = after.fields.find(f => f.id === fieldId) ?? null;

  return {
    portal: client.portal,
    created: true,
    field_id: fieldId,
    field_name: fieldName,
    field,
    hint:
      `Поле принадлежит ЗАДАЧАМ: значение передаётся в user_fields инструмента ` +
      `b24_task_create_from_template или в fields у b24_tasks_create как { "${fieldName}": … }. ` +
      'В user_fields шаблона его класть нельзя — у шаблонов свой набор полей.',
  };
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

export const taskUserfieldUpdateSchema = z.object({
  field_id: z.union([z.string(), z.number()]).describe('ID пользовательского поля (из b24_task_userfield_list)'),
  label: z.string().optional().describe('Новая подпись поля'),
  mandatory: z.boolean().optional().describe('Обязательность'),
  sort: z.number().int().optional().describe('Порядок сортировки'),
  xml_id: z.string().optional(),
  settings: z.record(z.any()).optional().describe('Доп. настройки типа'),
  list_values: z.array(z.string().min(1)).optional().describe(
    'Новые значения списка для полей типа enumeration'
  ),
  webhook_url: z.string().url().optional(),
});

export async function taskUserfieldUpdate(input) {
  const client = new Bitrix24Client(resolveWebhook(input.webhook_url));
  const fieldId = Number(input.field_id);
  if (!Number.isFinite(fieldId) || fieldId <= 0) {
    throw new Error(`Некорректный field_id: ${input.field_id}`);
  }

  // Тип и код поля Битрикс менять не даёт, поэтому в PARAMS кладём только то,
  // что действительно меняется.
  const params = {};
  if (input.label !== undefined) {
    params.LABEL = input.label;
    params.EDIT_FORM_LABEL = { ru: input.label, en: input.label };
  }
  if (input.mandatory !== undefined) params.MANDATORY = input.mandatory ? 'Y' : 'N';
  if (input.sort !== undefined) params.SORT = input.sort;
  if (input.xml_id !== undefined) params.XML_ID = input.xml_id;
  if (input.settings !== undefined) params.SETTINGS = input.settings;
  if (input.list_values?.length) {
    params.LIST = input.list_values.map((value, index) => ({ VALUE: value, SORT: (index + 1) * 10 }));
  }

  if (Object.keys(params).length === 0) {
    throw new Error('Не передано ни одного изменяемого свойства поля.');
  }

  await client.call('task.item.userfield.update', { ID: fieldId, PARAMS: params });

  const after = await taskUserfieldList({ webhook_url: input.webhook_url });
  const field = after.fields.find(f => f.id === fieldId) ?? null;

  return { portal: client.portal, updated: true, field_id: fieldId, field };
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

export const taskUserfieldDeleteSchema = z.object({
  field_id: z.union([z.string(), z.number()]).describe('ID удаляемого поля'),
  confirm: z.literal(true).describe(
    'Обязательное подтверждение: удаление поля стирает его значения во ВСЕХ задачах портала'
  ),
  webhook_url: z.string().url().optional(),
});

export async function taskUserfieldDelete({ field_id, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const fieldId = Number(field_id);
  if (!Number.isFinite(fieldId) || fieldId <= 0) {
    throw new Error(`Некорректный field_id: ${field_id}`);
  }

  const before = await taskUserfieldList({ webhook_url });
  const field = before.fields.find(f => f.id === fieldId);
  if (!field) {
    throw new Error(`Поле с ID ${fieldId} не найдено среди пользовательских полей задач.`);
  }

  await client.call('task.item.userfield.delete', { ID: fieldId });

  const after = await taskUserfieldList({ webhook_url });
  const stillThere = after.fields.some(f => f.id === fieldId);

  return {
    portal: client.portal,
    deleted: !stillThere,
    field_id: fieldId,
    field_name: field.field_name,
    ...(stillThere ? { warning: 'Портал принял вызов, но поле всё ещё в списке.' } : {}),
  };
}

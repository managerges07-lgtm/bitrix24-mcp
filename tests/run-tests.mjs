#!/usr/bin/env node
// Тесты шаблонов задач и пользовательских полей задач.
//
//   node tests/run-tests.mjs            — unit + tools/list (без сети)
//   node tests/run-tests.mjs --live     — плюс сквозной прогон на портале
//   node tests/run-tests.mjs --live-only
//
// Живая часть создаёт на портале временное поле, шаблон и задачу с префиксом
// [MCP TEST] и удаляет их за собой. Нужен B24_DEFAULT_WEBHOOK.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  extractTags, embedTags, buildCrmCodes, normalizeTemplate,
} from '../src/tools/task-templates.js';
import { phpUnserialize, toIdList, toObject } from '../src/utils/php-serialize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_USER_ID = Number(process.env.B24_TEST_USER_ID || 359);
const TEST_DEAL_ID = Number(process.env.B24_TEST_DEAL_ID || 1833);
const STAMP = Date.now();
const TEMPLATE_TITLE = `[MCP TEST] Шаблон ${STAMP}`;
const FIELD_CODE = `UF_MCP_TEST_${STAMP}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ─── Клиент MCP поверх stdio ──────────────────────────────────────────────────

class McpStdioClient {
  constructor() {
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
  }

  async start() {
    this.child = spawn(process.execPath, ['index.js'], {
      cwd: ROOT,
      env: { ...process.env, B24_TRANSPORT: 'stdio' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this._onData(chunk));
    this.child.stderr.on('data', () => {}); // баннер подключения — не мешает

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'task-template-tests', version: '1.0.0' },
    });
    this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? 'MCP error'));
      else entry.resolve(message.result);
    }
  }

  _send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Таймаут вызова ${method}`));
      }, 180000).unref();
    });
  }

  // Возвращает распарсенный JSON инструмента; ошибку инструмента бросает наверх.
  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    const text = result.content?.map(c => c.text).join('\n') ?? '';
    if (result.isError) throw new Error(`${name}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  // То же, но ошибку инструмента возвращает как значение — для негативных проверок.
  async tryTool(name, args) {
    try {
      return { ok: true, value: await this.callTool(name, args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  stop() {
    this.child?.kill();
  }
}

// ─── Юнит-тесты: чистые функции, без сети ─────────────────────────────────────

function runUnitTests() {
  section('Юнит-тесты: разбор PHP-сериализации');

  check('toIdList разворачивает список ID',
    JSON.stringify(toIdList('a:2:{i:0;s:3:"359";i:1;s:1:"1";}')) === '[359,1]');
  check('toIdList на пустом массиве даёт []',
    JSON.stringify(toIdList('a:0:{}')) === '[]');
  check('toIdList терпит null', JSON.stringify(toIdList(null)) === '[]');
  check('toIdList пропускает готовый массив',
    JSON.stringify(toIdList([5, '7'])) === '[5,7]');

  const replicate = toObject(
    'a:3:{s:6:"PERIOD";s:7:"monthly";s:15:"MONTHLY_DAY_NUM";i:28;s:9:"WEEK_DAYS";a:0:{}}'
  );
  check('toObject читает REPLICATE_PARAMS',
    replicate?.PERIOD === 'monthly' && replicate?.MONTHLY_DAY_NUM === 28);

  // Длина строки в PHP считается в БАЙТАХ — кириллица ломает наивный парсер.
  const cyrillic = phpUnserialize('a:1:{i:0;s:10:"Пункт";}');
  check('phpUnserialize считает длину строки в байтах',
    Array.isArray(cyrillic) && cyrillic[0] === 'Пункт', JSON.stringify(cyrillic));

  check('phpUnserialize понимает bool и null',
    phpUnserialize('b:1;') === true && phpUnserialize('N;') === null);

  section('Юнит-тесты: теги в описании шаблона');

  const embedded = embedTags('Описание шаблона', ['срочно', 'отдел продаж']);
  check('embedTags дописывает маркер', embedded.includes('[MCP_TAGS]: срочно, отдел продаж'));

  const back = extractTags(embedded);
  check('extractTags возвращает исходное описание', back.description === 'Описание шаблона', back.description);
  check('extractTags возвращает теги',
    JSON.stringify(back.tags) === JSON.stringify(['срочно', 'отдел продаж']));

  check('extractTags без маркера не трогает текст',
    extractTags('Просто текст').description === 'Просто текст' &&
    extractTags('Просто текст').tags.length === 0);

  check('embedTags без тегов не оставляет маркер',
    embedTags(embedded, []) === 'Описание шаблона', embedTags(embedded, []));

  check('embedTags не дублирует маркер при повторе',
    (embedTags(embedded, ['новый']).match(/\[MCP_TAGS\]/g) ?? []).length === 1);

  check('embedTags работает с пустым описанием',
    embedTags('', ['a']) === '[MCP_TAGS]: a', embedTags('', ['a']));

  section('Юнит-тесты: CRM-привязки');

  check('buildCrmCodes собирает коды из объекта',
    JSON.stringify(buildCrmCodes({ crm: { deals: [1833], leads: ['1179'] } })) ===
    JSON.stringify(['L_1179', 'D_1833']));

  check('buildCrmCodes принимает сырые коды',
    JSON.stringify(buildCrmCodes({ crm_bindings: ['CO_1', 'DYNAMIC_1040_5'] })) ===
    JSON.stringify(['CO_1', 'DYNAMIC_1040_5']));

  check('buildCrmCodes убирает дубли',
    JSON.stringify(buildCrmCodes({ crm: { deals: [1833] }, crm_bindings: ['D_1833'] })) ===
    JSON.stringify(['D_1833']));

  let rejected = false;
  try {
    buildCrmCodes({ crm_bindings: ['сделка 1833'] });
  } catch {
    rejected = true;
  }
  check('buildCrmCodes отвергает мусорный код', rejected);

  section('Юнит-тесты: нормализация шаблона');

  const normalized = normalizeTemplate({
    ID: '79',
    TITLE: 'Шаблон',
    DESCRIPTION: 'Текст\n\n[MCP_TAGS]: a, b',
    PRIORITY: '2',
    CREATED_BY: '359',
    RESPONSIBLE_ID: '425',
    ACCOMPLICES: 'a:1:{i:0;s:1:"1";}',
    AUDITORS: 'a:0:{}',
    GROUP_ID: null,
    DEADLINE_AFTER: '86400',
    TIME_ESTIMATE: '3600',
    TASK_CONTROL: 'Y',
    REPLICATE: 'N',
    UF_CRM_TASK: ['D_1833'],
    UF_AUTO_1: 12.5,
  });

  check('normalizeTemplate приводит ID к числу', normalized.id === 79);
  check('normalizeTemplate вынимает теги', JSON.stringify(normalized.tags) === '["a","b"]');
  check('normalizeTemplate чистит описание', normalized.description === 'Текст');
  check('normalizeTemplate разворачивает соисполнителей',
    JSON.stringify(normalized.accomplices) === '[1]');
  check('normalizeTemplate отдаёт пустых наблюдателей как []',
    JSON.stringify(normalized.auditors) === '[]');
  check('normalizeTemplate переводит Y/N в boolean',
    normalized.task_control === true && normalized.replicate === false);
  check('normalizeTemplate группу без значения делает нулём', normalized.group_id === 0);
  check('normalizeTemplate отделяет пользовательские поля от CRM',
    JSON.stringify(normalized.crm) === '["D_1833"]' && normalized.user_fields.UF_AUTO_1 === 12.5);
}

// ─── tools/list ───────────────────────────────────────────────────────────────

const NEW_TOOLS = [
  'b24_task_template_create',
  'b24_task_template_list',
  'b24_task_template_update',
  'b24_task_create_from_template',
  'b24_task_userfield_list',
  'b24_task_userfield_create',
  'b24_task_userfield_update',
  'b24_task_userfield_delete',
];

const EXISTING_SAMPLE = [
  'b24_call', 'b24_batch', 'b24_crm_list', 'b24_tasks_create', 'b24_tasks_list',
  'b24_kb2_page_create', 'b24_mail_message_list', 'b24_disk_file_upload',
];

async function runToolsListTests(client) {
  section('tools/list');

  const { tools } = await client.request('tools/list', {});
  const names = tools.map(t => t.name);

  check(`сервер отдал список инструментов (${names.length})`, names.length > 0);

  for (const name of NEW_TOOLS) {
    check(`${name} присутствует в tools/list`, names.includes(name));
  }

  // Регрессия: старые инструменты не должны пропасть.
  for (const name of EXISTING_SAMPLE) {
    check(`${name} не сломан регистрацией новых`, names.includes(name));
  }

  check('нет дублей имён инструментов', new Set(names).size === names.length);

  const createTool = tools.find(t => t.name === 'b24_task_template_create');
  const props = createTool?.inputSchema?.properties ?? {};
  check('у b24_task_template_create есть обязательные поля схемы',
    Boolean(props.title && props.responsible_id));
  check('схема b24_task_template_create описывает чек-лист, теги и CRM',
    Boolean(props.checklist && props.tags && props.crm && props.user_fields));
  check('title и responsible_id помечены обязательными',
    JSON.stringify(createTool?.inputSchema?.required ?? []).includes('title'));

  const fromTemplate = tools.find(t => t.name === 'b24_task_create_from_template');
  check('у b24_task_create_from_template есть защита от дублей',
    Boolean(fromTemplate?.inputSchema?.properties?.dedup_window_hours));

  return names.length;
}

// ─── Живой прогон на портале ──────────────────────────────────────────────────

async function runLiveTests(client) {
  section('Живой прогон: пользовательское поле задач');

  const created = [];
  let fieldId = null;
  let templateId = null;
  let taskId = null;

  try {
    const field = await client.callTool('b24_task_userfield_create', {
      field_name: FIELD_CODE,
      type: 'double',
      label: 'MCP тестовое число',
      sort: 500,
    });
    fieldId = field.field_id;
    check('поле задач создано', field.created === true && fieldId > 0, JSON.stringify(field).slice(0, 200));
    check('код поля нормализован с префиксом UF_', field.field_name === FIELD_CODE);

    const fields = await client.callTool('b24_task_userfield_list', {
      with_types: true, with_template_fields: true,
    });
    check('новое поле видно в списке полей задач',
      fields.fields.some(f => f.id === fieldId));
    check('список типов полей получен', (fields.available_types ?? []).length > 0);
    check('список полей шаблонов получен отдельно',
      Array.isArray(fields.template_fields) && fields.template_fields.length > 0);
    // Ключевое отличие: поле задач НЕ становится полем шаблона.
    check('поле задач не попадает в набор полей шаблона',
      !(fields.template_fields ?? []).some(f => f.field_name === FIELD_CODE),
      JSON.stringify(fields.template_fields));

    const dupField = await client.callTool('b24_task_userfield_create', {
      field_name: FIELD_CODE, type: 'double',
    });
    check('повторное создание поля не плодит дубль',
      dupField.created === false && dupField.reason === 'duplicate');

    const renamed = await client.callTool('b24_task_userfield_update', {
      field_id: fieldId, label: 'MCP тестовое число (изменено)', sort: 510,
    });
    check('поле задач обновлено', renamed.updated === true && renamed.field?.sort === 510,
      JSON.stringify(renamed.field));

    section('Живой прогон: шаблон задачи');

    // У шаблонов свой набор пользовательских полей и создать поле там через REST
    // нельзя, поэтому для проверки берём то, что на портале уже есть.
    const templateUf = (fields.template_fields ?? []).find(f =>
      !['UF_CRM_TASK', 'UF_TASK_WEBDAV_FILES'].includes(f.field_name) &&
      ['double', 'integer', 'string'].includes(f.type)
    );
    const templateUfValue = templateUf?.type === 'string' ? 'mcp' : 7;
    if (!templateUf) {
      console.log('  note на портале нет пригодного пользовательского поля шаблона — проверка значения пропущена');
    }

    const template = await client.callTool('b24_task_template_create', {
      title: TEMPLATE_TITLE,
      description: 'Описание тестового шаблона',
      responsible_id: TEST_USER_ID,
      created_by: TEST_USER_ID,
      priority: 2,
      deadline_after: 86400,
      time_estimate: 3600,
      task_control: true,
      tags: ['mcp-тест', 'шаблоны'],
      crm: { deals: [TEST_DEAL_ID] },
      ...(templateUf ? { user_fields: { [templateUf.field_name]: templateUfValue } } : {}),
      checklist: [
        { title: 'Первый пункт' },
        { title: 'Второй пункт', is_important: true },
      ],
    });
    templateId = template.template_id;
    check('шаблон создан', template.created === true && templateId > 0,
      JSON.stringify(template).slice(0, 300));
    check('шаблон перечитан с портала', template.template?.id === templateId);
    check('название сохранено', template.template?.title === TEMPLATE_TITLE);
    check('приоритет сохранён', template.template?.priority === 2);
    check('смещение срока сохранено', template.template?.deadline_after === 86400);
    check('теги сохранены',
      JSON.stringify(template.template?.tags) === JSON.stringify(['mcp-тест', 'шаблоны']),
      JSON.stringify(template.template?.tags));
    check('описание отделено от тегов', template.template?.description === 'Описание тестового шаблона');
    check('CRM-привязка сохранена',
      (template.template?.crm ?? []).includes(`D_${TEST_DEAL_ID}`),
      JSON.stringify(template.template?.crm));
    if (templateUf) {
      check('пользовательское поле шаблона сохранено',
        String(template.template?.user_fields?.[templateUf.field_name]) === String(templateUfValue),
        JSON.stringify(template.template?.user_fields));
    }
    check('чек-лист шаблона записан', (template.template?.checklist ?? []).length === 2,
      JSON.stringify(template.template?.checklist));
    check('порядок пунктов чек-листа сохранён',
      template.template?.checklist?.[0]?.title === 'Первый пункт');
    check('важность пункта сохранена', template.template?.checklist?.[1]?.is_important === true);
    check('создание прошло без предупреждений',
      (template.warnings ?? []).length === 0, JSON.stringify(template.warnings));

    const duplicate = await client.callTool('b24_task_template_create', {
      title: TEMPLATE_TITLE, responsible_id: TEST_USER_ID, created_by: TEST_USER_ID,
    });
    check('повторный шаблон не создаётся',
      duplicate.created === false && duplicate.reason === 'duplicate',
      JSON.stringify(duplicate).slice(0, 200));
    check('дубль указывает на существующий шаблон', duplicate.template?.id === templateId);

    section('Живой прогон: список и обновление шаблона');

    const list = await client.callTool('b24_task_template_list', { title: `Шаблон ${STAMP}` });
    check('шаблон найден в списке', list.templates?.some(t => t.id === templateId),
      `count=${list.count}, source=${list.source}`);
    check('список отработал обходным сканом', list.source === 'id-scan' || list.source === 'tasks.template.list');

    const byCreator = await client.callTool('b24_task_template_list', { created_by: TEST_USER_ID });
    check('фильтр по постановщику работает',
      byCreator.templates?.every(t => t.created_by === TEST_USER_ID));

    const updated = await client.callTool('b24_task_template_update', {
      template_id: templateId,
      priority: 1,
      tags: ['после-правки'],
      checklist: [{ title: 'Единственный пункт после правки' }],
    });
    check('шаблон обновлён', updated.updated === true);
    check('приоритет изменён', updated.template?.priority === 1);
    check('теги заменены', JSON.stringify(updated.template?.tags) === JSON.stringify(['после-правки']),
      JSON.stringify(updated.template?.tags));
    check('описание пережило смену тегов',
      updated.template?.description === 'Описание тестового шаблона', updated.template?.description);
    check('чек-лист заменён целиком',
      updated.template?.checklist?.length === 1 &&
      updated.template.checklist[0].title === 'Единственный пункт после правки',
      JSON.stringify(updated.template?.checklist));
    check('CRM-привязка не потерялась при частичном обновлении',
      (updated.template?.crm ?? []).includes(`D_${TEST_DEAL_ID}`));

    section('Живой прогон: задача по шаблону');

    const task = await client.callTool('b24_task_create_from_template', {
      template_id: templateId,
      user_fields: { [FIELD_CODE]: 42 },
    });
    taskId = task.task_id;
    check('задача создана', task.created === true && taskId > 0, JSON.stringify(task).slice(0, 300));
    check('задача перечитана с портала', Number(task.task?.id) === taskId);
    check('название взято из шаблона', task.task?.title === TEMPLATE_TITLE);
    check('ссылка на задачу собрана', String(task.task_url).includes(`/tasks/task/view/${taskId}/`));
    check('срок посчитан из смещения шаблона', Boolean(task.task?.deadline), task.task?.deadline);
    check('теги перенесены в задачу',
      Object.values(task.task?.tags ?? {}).some(t => String(t.title).toLowerCase() === 'после-правки'),
      JSON.stringify(task.task?.tags));
    check('CRM-привязка перенесена',
      (task.task?.ufCrmTask ?? []).includes(`D_${TEST_DEAL_ID}`),
      JSON.stringify(task.task?.ufCrmTask));
    check('пользовательское поле задачи проставлено',
      Number(task.task?.[camel(FIELD_CODE)] ?? task.task?.[FIELD_CODE]) === 42,
      JSON.stringify(Object.keys(task.task ?? {})));
    check('чек-лист перенесён в задачу', task.checklist_items === 1);
    if (templateUf) {
      // Поле шаблона у задач отсутствует — инструмент обязан сказать об этом вслух.
      check('о непереносимом поле шаблона сказано явно',
        (task.warnings ?? []).some(w => w.includes(templateUf.field_name)),
        JSON.stringify(task.warnings));
    } else {
      check('создание задачи прошло без предупреждений',
        (task.warnings ?? []).length === 0, JSON.stringify(task.warnings));
    }

    const taskDup = await client.callTool('b24_task_create_from_template', {
      template_id: templateId,
    });
    check('повторная задача по шаблону не создаётся',
      taskDup.created === false && taskDup.reason === 'duplicate',
      JSON.stringify(taskDup).slice(0, 200));

    const forced = await client.callTool('b24_task_create_from_template', {
      template_id: templateId,
      title: `${TEMPLATE_TITLE} (форс)`,
      responsible_id: TEST_USER_ID,
      with_checklist: false,
    });
    check('переопределение названия создаёт новую задачу', forced.created === true);
    check('with_checklist:false не переносит чек-лист', forced.checklist_items === 0);
    if (forced.task_id) created.push(forced.task_id);

    section('Живой прогон: валидация входных данных');

    const badUser = await client.tryTool('b24_task_template_create', {
      title: `[MCP TEST] Несуществующий исполнитель ${STAMP}`,
      responsible_id: 99999999,
    });
    check('несуществующий пользователь отклонён',
      !badUser.ok && badUser.error.includes('не найдены'), badUser.error);

    const badCrm = await client.tryTool('b24_task_template_create', {
      title: `[MCP TEST] Плохой CRM ${STAMP}`,
      responsible_id: TEST_USER_ID,
      crm_bindings: ['сделка-1833'],
    });
    check('мусорный код CRM отклонён',
      !badCrm.ok && badCrm.error.includes('CRM-привязки'), badCrm.error);

    // Перепутанные сущности полей — самая вероятная ошибка модели, поэтому она
    // должна падать явно, а не молча терять значение.
    const ufInWrongPlace = await client.tryTool('b24_task_template_create', {
      title: `[MCP TEST] Поле задачи в шаблоне ${STAMP}`,
      responsible_id: TEST_USER_ID,
      user_fields: { [FIELD_CODE]: 1 },
    });
    check('поле задачи в user_fields шаблона отклонено',
      !ufInWrongPlace.ok && ufInWrongPlace.error.includes('Шаблоны задач не знают полей'),
      ufInWrongPlace.error);

    if (templateUf) {
      const tplUfInTask = await client.tryTool('b24_task_create_from_template', {
        template_id: templateId,
        user_fields: { [templateUf.field_name]: 1 },
      });
      check('поле шаблона в user_fields задачи отклонено',
        !tplUfInTask.ok && tplUfInTask.error.includes('Задачи не знают полей'),
        tplUfInTask.error);
    }

    const badPriority = await client.tryTool('b24_task_template_create', {
      title: `[MCP TEST] Плохой приоритет ${STAMP}`,
      responsible_id: TEST_USER_ID,
      priority: 9,
    });
    check('приоритет вне диапазона отклонён схемой', !badPriority.ok, badPriority.error);

    const missingTemplate = await client.tryTool('b24_task_create_from_template', {
      template_id: 99999999,
    });
    check('несуществующий шаблон даёт понятную ошибку',
      !missingTemplate.ok && missingTemplate.error.includes('не найден'), missingTemplate.error);

    const noConfirm = await client.tryTool('b24_task_userfield_delete', { field_id: fieldId });
    check('удаление поля без confirm запрещено', !noConfirm.ok, noConfirm.error);
  } finally {
    section('Уборка тестовых данных');

    for (const id of [taskId, ...created].filter(Boolean)) {
      const res = await client.tryTool('b24_call', { method: 'tasks.task.delete', params: { taskId: id } });
      check(`задача ${id} удалена`, res.ok, res.error);
    }
    if (templateId) {
      const res = await client.tryTool('b24_call', {
        method: 'tasks.template.delete', params: { templateId },
      });
      check(`шаблон ${templateId} удалён`, res.ok, res.error);
    }
    if (fieldId) {
      const res = await client.tryTool('b24_task_userfield_delete', { field_id: fieldId, confirm: true });
      check(`поле ${fieldId} удалено`, res.ok && res.value?.deleted === true, res.error ?? JSON.stringify(res.value));
    }
  }
}

// tasks.task.get отдаёт пользовательские поля в camelCase: UF_MCP_TEST_1 → ufMcpTest1.
function camel(fieldName) {
  return fieldName
    .toLowerCase()
    .split('_')
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const liveOnly = args.includes('--live-only');
const withLive = liveOnly || args.includes('--live');

if (!liveOnly) runUnitTests();

const client = new McpStdioClient();
try {
  await client.start();
  if (!liveOnly) await runToolsListTests(client);
  if (withLive) {
    if (!process.env.B24_DEFAULT_WEBHOOK) {
      console.log('\nЖивой прогон пропущен: не задан B24_DEFAULT_WEBHOOK.');
    } else {
      await runLiveTests(client);
    }
  }
} finally {
  client.stop();
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) {
  console.log(`Провалившиеся проверки:\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './src/config.js';

// ── Универсальные ─────────────────────────────────────────────────────────────
import { callSchema, universalCall, batchSchema, universalBatch } from './src/tools/universal-call.js';

// ── CRM: данные ───────────────────────────────────────────────────────────────
import {
  crmListSchema, crmList,
  crmGetSchema, crmGet,
  crmCreateSchema, crmCreate,
  crmUpdateSchema, crmUpdate,
  crmDeleteSchema, crmDelete,
  crmFieldsSchema, crmFields,
  timelineAddSchema, timelineAdd,
} from './src/tools/crm.js';

// ── CRM: конфигурация ─────────────────────────────────────────────────────────
import { connectTestSchema, connectTest } from './src/tools/connect-test.js';
import { readConfigSchema, readFullConfig } from './src/tools/read-config.js';
import { readEntityTypesSchema, readEntityTypes } from './src/tools/read-entity-types.js';
import { readPipelinesSchema, readPipelines } from './src/tools/read-pipelines.js';
import { readCustomFieldsSchema, readCustomFields } from './src/tools/read-custom-fields.js';
import { readAutomationsSchema, readAutomations } from './src/tools/read-automations.js';
import { readProductCatalogSchema, readProductCatalog } from './src/tools/read-product-catalog.js';
import { compareConfigsSchema, compareConfigs } from './src/tools/compare-configs.js';
import { applyConfigSchema, applyConfig } from './src/tools/apply-config.js';
import { saveUserMappingSchema, saveUserMappingTool } from './src/tools/save-user-mapping.js';

// ── Задачи ────────────────────────────────────────────────────────────────────
import {
  tasksListSchema, tasksList,
  tasksGetSchema, tasksGet,
  tasksCreateSchema, tasksCreate,
  tasksUpdateSchema, tasksUpdate,
  tasksCompleteSchema, tasksComplete,
} from './src/tools/tasks.js';

// ── Пользователи и отделы ──────────────────────────────────────────────────────
import { usersListSchema, usersList } from './src/tools/users-departments.js';
import { departmentsListSchema, departmentsList } from './src/tools/users-departments.js';

// ── Диск ──────────────────────────────────────────────────────────────────────
import {
  diskStoragesSchema, diskStorages,
  diskFolderListSchema, diskFolderList,
  diskFileGetSchema, diskFileGet,
  diskFileUploadSchema, diskFileUpload,
} from './src/tools/disk.js';

// ── Календарь ─────────────────────────────────────────────────────────────────
import { calendarListSchema, calendarList, calendarCreateSchema, calendarCreate } from './src/tools/calendar.js';

// ── Лента, уведомления, группы, бизнес-процессы, телефония ────────────────────
import {
  feedPostSchema, feedPost,
  notifySendSchema, notifySend,
  groupsListSchema, groupsList,
  chatSendSchema, chatSend,
  bizprocListSchema, bizprocList,
  bizprocStartSchema, bizprocStart,
  telephonyCallsSchema, telephonyCalls,
} from './src/tools/feed-notifications.js';

// ── Каталог / товары ──────────────────────────────────────────────────────────
import {
  productsListSchema, productsList,
  productsGetSchema, productsGet,
  productsCreateSchema, productsCreate,
  productsUpdateSchema, productsUpdate,
  productsSectionsSchema, productsSections,
} from './src/tools/catalog-products.js';

// ── Почта (чтение) ────────────────────────────────────────────────────────────
import {
  mailMailboxListSchema, mailMailboxList,
  mailMessageListSchema, mailMessageList,
  mailMessageGetSchema, mailMessageGet,
  mailMessageThreadSchema, mailMessageThread,
} from './src/tools/mail.js';

// ── База знаний ───────────────────────────────────────────────────────────────
import {
  kbListSchema, kbList,
  kbPagesSchema, kbPages,
  kbPageGetSchema, kbPageGet,
  kbPageCreateSchema, kbPageCreate,
  kbPagePublishSchema, kbPagePublish,
  kbBlockAddSchema, kbBlockAdd,
  kbBlockUpdateSchema, kbBlockUpdate,
  kbBlockDeleteSchema, kbBlockDelete,
  kbCardAddSchema, kbCardAdd,
  kbCardRemoveSchema, kbCardRemove,
  kbImageUploadSchema, kbImageUpload,
} from './src/tools/knowledge-base.js';

// ── База знаний 2.0 ───────────────────────────────────────────────────────────
import {
  kb2ListSchema, kb2List,
  kb2CreateSchema, kb2Create,
  kb2DeleteSchema, kb2Delete,
  kb2TreeSchema, kb2Tree,
  kb2PageGetSchema, kb2PageGet,
  kb2PageCreateSchema, kb2PageCreate,
  kb2PageUpdateSchema, kb2PageUpdate,
  kb2PageDeleteSchema, kb2PageDelete,
  kb2SearchSchema, kb2Search,
  kb2FileAddSchema, kb2FileAdd,
} from './src/tools/knowledge-base-2.js';

// ─────────────────────────────────────────────────────────────────────────────

function wrap(fn) {
  return async (params) => {
    try {
      const result = await fn(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err.response?.data
        ? `${err.message}\nBitrix24: ${JSON.stringify(err.response.data)}`
        : err.message;
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  };
}

// Registers ALL tools on an McpServer. Reused by the stdio transport (a single
// long-lived server) and by the http transport (a fresh server per request).
export function registerTools(server) {
// ── Универсальные ─────────────────────────────────────────────────────────────
server.tool('b24_call',
  'Вызывает ЛЮБОЙ REST-метод API Bitrix24. Используйте, когда нет специализированного инструмента. ' +
  'Полный справочник: https://dev.1c-bitrix.ru/rest_help/',
  callSchema.shape, wrap(universalCall));

server.tool('b24_batch',
  'Выполняет несколько вызовов API Bitrix24 в одном HTTP-запросе. ' +
  'Результаты одного вызова можно использовать как параметры следующего через $result[alias][поле].',
  batchSchema.shape, wrap(universalBatch));

// ── Подключение ───────────────────────────────────────────────────────────────
server.tool('b24_test_connection',
  'Проверяет подключение к вебхуку Bitrix24 и подтверждает данные портала и права пользователя.',
  connectTestSchema.shape, wrap(connectTest));

// ── CRM: данные ───────────────────────────────────────────────────────────────
server.tool('b24_crm_list',
  'Выводит список записей CRM: сделки, контакты, компании, лиды, предложения или элементы SPA. Поддерживает фильтры, выбор полей и автоматическую постраничную навигацию.',
  crmListSchema.shape, wrap(crmList));

server.tool('b24_crm_get',
  'Получает полную запись CRM по ID: сделка, контакт, компания, лид или элемент SPA.',
  crmGetSchema.shape, wrap(crmGet));

server.tool('b24_crm_create',
  'Создаёт новую запись CRM: сделку, контакт, компанию, лид, предложение или элемент SPA.',
  crmCreateSchema.shape, wrap(crmCreate));

server.tool('b24_crm_update',
  'Обновляет поля существующей записи CRM.',
  crmUpdateSchema.shape, wrap(crmUpdate));

server.tool('b24_crm_delete',
  'Удаляет запись CRM по ID.',
  crmDeleteSchema.shape, wrap(crmDelete));

server.tool('b24_crm_fields',
  'Выводит все доступные поля сущности CRM (стандартные + пользовательские) с их типами, названиями и настройками.',
  crmFieldsSchema.shape, wrap(crmFields));

server.tool('b24_crm_timeline_add',
  'Добавляет комментарий или активность в таймлайн записи CRM.',
  timelineAddSchema.shape, wrap(timelineAdd));

// ── CRM: конфигурация ─────────────────────────────────────────────────────────
server.tool('b24_read_full_config',
  'Читает ВСЮ структурную конфигурацию портала: сущности, воронки, стадии, поля, автоматизации, каталог и пользователей. Экспортирует в JSON.',
  readConfigSchema.shape, wrap(readFullConfig));

server.tool('b24_read_entity_types',
  'Читает все типы сущностей CRM и SPA (смарт-процессы) с их атрибутами.',
  readEntityTypesSchema.shape, wrap(readEntityTypes));

server.tool('b24_read_pipelines',
  'Читает воронки и их стадии с цветами, семантикой и порядком.',
  readPipelinesSchema.shape, wrap(readPipelines));

server.tool('b24_read_custom_fields',
  'Читает пользовательские поля всех сущностей CRM с их полной конфигурацией.',
  readCustomFieldsSchema.shape, wrap(readCustomFields));

server.tool('b24_read_automations',
  'Читает правила автоматизации (роботы и триггеры) по стадиям с условиями и действиями.',
  readAutomationsSchema.shape, wrap(readAutomations));

server.tool('b24_read_product_catalog',
  'Читает структуру конфигурации каталога товаров: разделы, свойства, цены и единицы измерения.',
  readProductCatalogSchema.shape, wrap(readProductCatalog));

server.tool('b24_compare_configs',
  'Сравнивает два JSON-файла конфигурации и сообщает, что есть в источнике и отсутствует в приёмнике, и наоборот.',
  compareConfigsSchema.shape, wrap(compareConfigs));

server.tool('b24_apply_config',
  'Применяет экспортированную конфигурацию к целевому порталу. Создаёт, если не существует, обновляет, если существует, никогда не удаляет.',
  applyConfigSchema.shape, wrap(applyConfig));

server.tool('b24_save_user_mapping',
  'Генерирует и сохраняет сопоставление ID пользователей между двумя порталами, необходимое для переноса автоматизаций.',
  saveUserMappingSchema.shape, wrap(saveUserMappingTool));

// ── Задачи ────────────────────────────────────────────────────────────────────
server.tool('b24_tasks_list',
  'Выводит список задач с фильтрами по ответственному, группе, статусу, сроку и т.д.',
  tasksListSchema.shape, wrap(tasksList));

server.tool('b24_tasks_get',
  'Получает полную информацию о задаче по ID.',
  tasksGetSchema.shape, wrap(tasksGet));

server.tool('b24_tasks_create',
  'Создаёт новую задачу с названием, описанием, ответственным, сроком, приоритетом и другими параметрами.',
  tasksCreateSchema.shape, wrap(tasksCreate));

server.tool('b24_tasks_update',
  'Обновляет поля существующей задачи.',
  tasksUpdateSchema.shape, wrap(tasksUpdate));

server.tool('b24_tasks_complete',
  'Отмечает задачу как завершённую.',
  tasksCompleteSchema.shape, wrap(tasksComplete));

// ── Пользователи и отделы ──────────────────────────────────────────────────────
server.tool('b24_users_list',
  'Выводит список активных пользователей с именем, email, должностью, отделом и статусом онлайн.',
  usersListSchema.shape, wrap(usersList));

server.tool('b24_departments_list',
  'Выводит список отделов организационной структуры с иерархией и руководителями.',
  departmentsListSchema.shape, wrap(departmentsList));

// ── Диск ──────────────────────────────────────────────────────────────────────
server.tool('b24_disk_storages',
  'Выводит список всех доступных хранилищ (личное, групп, компании).',
  diskStoragesSchema.shape, wrap(diskStorages));

server.tool('b24_disk_folder_list',
  'Выводит содержимое папки в Диске Bitrix24.',
  diskFolderListSchema.shape, wrap(diskFolderList));

server.tool('b24_disk_file_get',
  'Получает информацию о файле, включая ссылку для скачивания.',
  diskFileGetSchema.shape, wrap(diskFileGet));

server.tool('b24_disk_file_upload',
  'Загружает файл в папку Диска Bitrix24.',
  diskFileUploadSchema.shape, wrap(diskFileUpload));

// ── Календарь ─────────────────────────────────────────────────────────────────
server.tool('b24_calendar_list',
  'Выводит события личного, группового или корпоративного календаря с фильтром по датам.',
  calendarListSchema.shape, wrap(calendarList));

server.tool('b24_calendar_create',
  'Создаёт событие в календаре с участниками, местом и напоминаниями.',
  calendarCreateSchema.shape, wrap(calendarCreate));

// ── Лента и коммуникации ──────────────────────────────────────────────────────
server.tool('b24_feed_post',
  'Публикует сообщение в Живой ленте Bitrix24 с поддержкой BB-code.',
  feedPostSchema.shape, wrap(feedPost));

server.tool('b24_notify_send',
  'Отправляет персональное уведомление пользователю внутри Bitrix24.',
  notifySendSchema.shape, wrap(notifySend));

server.tool('b24_chat_send',
  'Отправляет сообщение в личный или групповой чат мессенджера Bitrix24.',
  chatSendSchema.shape, wrap(chatSend));

// ── Группы ────────────────────────────────────────────────────────────────────
server.tool('b24_groups_list',
  'Выводит список рабочих групп и проектов с фильтрами по статусу и видимости.',
  groupsListSchema.shape, wrap(groupsList));

// ── Бизнес-процессы ───────────────────────────────────────────────────────────
server.tool('b24_bizproc_list',
  'Выводит список активных экземпляров бизнес-процессов с фильтром по сущности или записи.',
  bizprocListSchema.shape, wrap(bizprocList));

server.tool('b24_bizproc_start',
  'Запускает бизнес-процесс для документа или записи CRM.',
  bizprocStartSchema.shape, wrap(bizprocStart));

// ── Телефония ─────────────────────────────────────────────────────────────────
server.tool('b24_telephony_calls',
  'Выводит историю звонков с фильтрами по сущности CRM, пользователю, длительности и дате.',
  telephonyCallsSchema.shape, wrap(telephonyCalls));

// ── Каталог / товары ──────────────────────────────────────────────────────────
server.tool('b24_products_list',
  'Выводит список товаров каталога с фильтрами по разделу, цене, активности и т.д.',
  productsListSchema.shape, wrap(productsList));

server.tool('b24_products_get',
  'Получает полную информацию о товаре по ID.',
  productsGetSchema.shape, wrap(productsGet));

server.tool('b24_products_create',
  'Создаёт новый товар в каталоге.',
  productsCreateSchema.shape, wrap(productsCreate));

server.tool('b24_products_update',
  'Обновляет товар каталога.',
  productsUpdateSchema.shape, wrap(productsUpdate));

server.tool('b24_products_sections',
  'Выводит разделы/категории каталога товаров.',
  productsSectionsSchema.shape, wrap(productsSections));

// ── Почта / чтение (REST v3, требуется scope `mail`) ──────────────────────────
server.tool('b24_mail_mailbox_list',
  'Выводит список почтовых ящиков пользователя вебхука с опциональным фильтром по имени или email. ' +
  'Возвращает id, name, email и senderName. id используется в b24_mail_message_list.',
  mailMailboxListSchema.shape, wrap(mailMailboxList));

server.tool('b24_mail_message_list',
  'Выводит список писем почтового ящика (по mailbox_id). Позволяет фильтровать по тексту, диапазону дат, ' +
  'признаку прочтения, наличию вложений и папке, с постраничной навигацией.',
  mailMessageListSchema.shape, wrap(mailMessageList));

server.tool('b24_mail_message_get',
  'Получает письмо целиком по его ID, включая тело сообщения. Позволяет выбрать поля через select.',
  mailMessageGetSchema.shape, wrap(mailMessageGet));

server.tool('b24_mail_message_thread',
  'Возвращает цепочку писем по ID любого сообщения переписки. Максимум 50.',
  mailMessageThreadSchema.shape, wrap(mailMessageThread));

// ── База знаний (модуль landing, требуется scope `landing`) ───────────────────
server.tool('b24_kb_list',
  'Выводит список баз знаний портала с ID, названием, адресом и признаком публикации. ' +
  'ID нужен для b24_kb_pages.',
  kbListSchema.shape, wrap(kbList));

server.tool('b24_kb_pages',
  'Выводит статьи (страницы) базы знаний с публичными ссылками. ' +
  'Страницы с is_area = true — служебные включаемые области (сайдбар, шаблоны), а не статьи.',
  kbPagesSchema.shape, wrap(kbPages));

server.tool('b24_kb_page_get',
  'Читает содержимое статьи по блокам. detail="text" — текст статьи; ' +
  'detail="nodes" — карта редактируемых нод и карточек с текущими значениями и готовыми ' +
  'селекторами для b24_kb_block_update; detail="html" — плюс сырой HTML. ' +
  'По умолчанию читает черновик: именно его ID блоков годятся для правки.',
  kbPageGetSchema.shape, wrap(kbPageGet));

server.tool('b24_kb_page_create',
  'Создаёт статью в базе знаний. Страница создаётся пустой и неопубликованной: ' +
  'наполните её через b24_kb_block_add и опубликуйте через b24_kb_page_publish.',
  kbPageCreateSchema.shape, wrap(kbPageCreate));

server.tool('b24_kb_page_publish',
  'Публикует статью базы знаний: переносит черновик в публичную версию и делает страницу видимой. ' +
  'Нужен после любых правок блоков.',
  kbPagePublishSchema.shape, wrap(kbPagePublish));

server.tool('b24_kb_block_add',
  'Добавляет блок вёрстки в статью базы знаний: заголовок, текст, FAQ, колонки. ' +
  'Блок попадает в черновик, порядок задаётся через after_block_id.',
  kbBlockAddSchema.shape, wrap(kbBlockAdd));

server.tool('b24_kb_block_update',
  'Меняет содержимое блока статьи: тексты, картинки и ссылки задаются селекторами нод. ' +
  'Значения для карточек передавайте по одному с индексом (".selector@0", ".selector@1") — ' +
  'массив значений Bitrix24 молча игнорирует. Правка идёт в черновик.',
  kbBlockUpdateSchema.shape, wrap(kbBlockUpdate));

server.tool('b24_kb_block_delete',
  'Удаляет блок из статьи базы знаний. Нужен, в частности, чтобы вычистить демо-контент шаблона ' +
  'после копирования страницы.',
  kbBlockDeleteSchema.shape, wrap(kbBlockDelete));

server.tool('b24_kb_card_add',
  'Добавляет карточку в блок статьи (пункт FAQ, колонку, элемент списка). ' +
  'Без параметра content клонирует карточку, указанную селектором.',
  kbCardAddSchema.shape, wrap(kbCardAdd));

server.tool('b24_kb_card_remove',
  'Удаляет карточку из блока статьи по селектору с индексом. Так убираются лишние ' +
  'пункты и колонки, оставшиеся от шаблона блока.',
  kbCardRemoveSchema.shape, wrap(kbCardRemove));

server.tool('b24_kb_image_upload',
  'Загружает картинку и привязывает её к блоку статьи. Возвращает src, который затем ' +
  'прописывается в ноду картинки через b24_kb_block_update.',
  kbImageUploadSchema.shape, wrap(kbImageUpload));

// ── База знаний 2.0 (REST v3, модуль note, требуется scope `note`) ────────────
// Отдельный от landing движок: база + дерево документов, содержимое — Markdown,
// публикации нет. Работает через свой вебхук B24_NOTE_WEBHOOK.
server.tool('b24_kb2_list',
  'Выводит список баз знаний 2.0 портала (движок note). Это НЕ то же самое, что b24_kb_list: ' +
  'старые базы на движке landing здесь не видны, и наоборот. ID нужен для b24_kb2_tree.',
  kb2ListSchema.shape, wrap(kb2List));

server.tool('b24_kb2_create',
  'Создаёт базу знаний 2.0. В отличие от старого движка, базу можно завести прямо из API. ' +
  'Доступ сотрудникам к ней выдаётся только в интерфейсе портала.',
  kb2CreateSchema.shape, wrap(kb2Create));

server.tool('b24_kb2_delete',
  'Удаляет базу знаний 2.0 в корзину ВМЕСТЕ СО ВСЕМИ её документами. Требует confirm: true.',
  kb2DeleteSchema.shape, wrap(kb2Delete));

server.tool('b24_kb2_tree',
  'Выводит дерево документов базы знаний 2.0: заголовки, вложенность через children и ссылки ' +
  'на статьи. Содержимого документов не отдаёт — за ним b24_kb2_page_get.',
  kb2TreeSchema.shape, wrap(kb2Tree));

server.tool('b24_kb2_page_get',
  'Читает документ базы знаний 2.0 целиком: заголовок и содержимое в Markdown одним полем. ' +
  'Обязателен перед правкой: b24_kb2_page_update заменяет текст целиком.',
  kb2PageGetSchema.shape, wrap(kb2PageGet));

server.tool('b24_kb2_page_create',
  'Создаёт документ в базе знаний 2.0 с содержимым в Markdown. Публиковать не нужно: документ ' +
  'доступен по ссылке сразу. Через parent_id статья вкладывается в раздел дерева.',
  kb2PageCreateSchema.shape, wrap(kb2PageCreate));

server.tool('b24_kb2_page_update',
  'Меняет заголовок и/или содержимое документа базы знаний 2.0. Markdown заменяется ЦЕЛИКОМ — ' +
  'сначала прочитайте текущий текст через b24_kb2_page_get. При конфликте с открытым ' +
  'редактором повторите с overwrite: true.',
  kb2PageUpdateSchema.shape, wrap(kb2PageUpdate));

server.tool('b24_kb2_page_delete',
  'Удаляет документ базы знаний 2.0 в корзину. Удаление каскадное: вложенные документы ' +
  'уезжают вместе с родителем.',
  kb2PageDeleteSchema.shape, wrap(kb2PageDelete));

server.tool('b24_kb2_search',
  'Ищет документы во всех базах знаний 2.0 по заголовку и тексту. Возвращает фрагменты ' +
  'совпадений и ссылки на статьи.',
  kb2SearchSchema.shape, wrap(kb2Search));

server.tool('b24_kb2_file_add',
  'Загружает картинку или файл в документ базы знаний 2.0 и возвращает готовый блок вида ' +
  '[[image fileId=...]]. В текст он сам не попадает: вставьте блок в Markdown и сохраните ' +
  'через b24_kb2_page_update. Удалить загруженный файл через API нельзя — не перезаливайте ' +
  'одну и ту же картинку при каждой правке.',
  kb2FileAddSchema.shape, wrap(kb2FileAdd));
}

// ─────────────────────────────────────────────────────────────────────────────

// Local transport (Claude Desktop): a single long-lived server over stdio.
async function runStdio() {
  const server = new McpServer({ name: 'bitrix24-config', version: '2.0.0' });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Автопроверка подключения при запуске
  if (process.env.B24_DEFAULT_WEBHOOK) {
    try {
      const { Bitrix24Client } = await import('./src/bitrix24/client.js');
      const client = new Bitrix24Client(process.env.B24_DEFAULT_WEBHOOK);
      const res = await client.call('profile');
      const name = `${res.result?.NAME || ''} ${res.result?.LAST_NAME || ''}`.trim();
      process.stderr.write(`[bitrix24] ✓ Подключено к ${client.portal} как ${name} | активных инструментов: ${Object.keys(server._registeredTools ?? {}).length || 69}\n`);
    } catch (err) {
      process.stderr.write(`[bitrix24] ✗ Не удалось подключиться: ${err.message}\n`);
    }
  }
}

const config = loadConfig();
if (config.transport === 'http') {
  // Lazy import: http-server pulls in express/oauth deps only in http mode.
  // registerTools is passed in (not imported by http-server) to keep that module
  // free of any dependency back on index.js.
  const { startHttpServer } = await import('./src/http-server.js');
  await startHttpServer(config, registerTools);
} else {
  await runStdio();
}

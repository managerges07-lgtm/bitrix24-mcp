# CLAUDE.md

Ориентир для Claude Code при работе с этим репозиторием.

## О проекте

MCP-сервер (Model Context Protocol) для **Bitrix24**. Подключает Claude к порталу Bitrix24
через входящий вебхук и предоставляет 69 инструментов: CRM, задачи, диск, календарь,
телефония, каталог товаров, чтение почты, база знаний (два движка: landing и 2.0),
экспорт/сравнение/перенос конфигурации и универсальный вызов любого REST-метода.

- Node.js ≥ 18, ESM (`"type": "module"` в package.json).
- Зависимости: `@modelcontextprotocol/sdk`, `axios`, `zod`, а для http-режима — `express`, `cors`.

## Команды

- Запуск: `npm start` (то же, что `node index.js`).
- Сборки нет. Тестов нет. Линтера нет.
- Проверка синтаксиса файла: `node --check <файл>` (быстрый гейт перед коммитом).

## Транспорты (переменная `B24_TRANSPORT`)

- `stdio` (по умолчанию) — локальный запуск рядом с Claude Desktop, без авторизации.
- `http` — удалённый сервер: Streamable HTTP + Google OAuth + allowlist email
  (`B24_ALLOWED_EMAILS`). Все параметры окружения — в `.env.example`, деплой — в
  [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

## Архитектура

```
index.js                     точка входа: registerTools() + выбор транспорта
├─ src/config.js             loadConfig() из переменных окружения
├─ src/tools/*.js            по одному файлу на функциональную область
├─ src/bitrix24/
│  ├─ client.js              HTTP-клиент к Bitrix24 (rate limit + retry)
│  ├─ reader.js              чтение структурной конфигурации (для миграции)
│  └─ writer.js              применение конфигурации на целевой портал
├─ src/utils/                pagination, rate-limiter, resolve-webhook, user-mapping
├─ src/auth/                 GoogleOAuthProvider (только http-режим)
└─ src/http-server.js        express-сервер для http-режима
```

### Регистрация инструментов

`registerTools(server)` в [index.js](index.js) регистрирует все инструменты и
переиспользуется обоими транспортами. Каждый инструмент:

```js
server.tool('b24_xxx', 'Описание для модели', xxxSchema.shape, wrap(xxxHandler));
```

`wrap()` сериализует результат в JSON-текст и превращает ошибки в `isError`.

### Файл инструмента (`src/tools/*.js`)

Экспортирует пару: zod-схему `xxxSchema` и async-обработчик `xxx({...})`. Обработчик
получает вебхук через `resolveWebhook(webhook_url)`, создаёт `Bitrix24Client`, вызывает
метод и возвращает объект (обычно с полем `portal`). Схемы почти всегда имеют
опциональный `webhook_url`.

### Клиент Bitrix24 (`src/bitrix24/client.js`)

- `client.call(method, params)` — классический **REST v1**:
  `/rest/{user}/{token}/{method}.json`. Ошибки приходят как `error` + `error_description`.
- `client.callV3(method, params, options)` — **REST v3**: базовый путь `/rest/api/...`, без
  `.json`. Используется семействами `mail.*` и `note.*`. Ошибки приходят объектом
  `{ code, message, validation[] }` и со статусом 4xx — поэтому тело разбирается и в `catch`;
  `validation` вклеивается в текст ошибки, разобранная ошибка кладётся в `err.b24`.
  `options.idempotencyKey` шлёт заголовок `Idempotency-Key` (портал хранит ответ 24 ч) —
  нужен создающим методам, чтобы внутренний ретрай не породил дубль.
- Общий rate limiter (мин. интервал 500 мс) и ретраи на 429 / таймаут.

### Пагинация

- v1: `fetchAllPages(client, method, params)` в [src/utils/pagination.js](src/utils/pagination.js) — по `start`/`total`.
- v3: объект `{ pagination: { page, limit, offset } }`, данные в `result.items`.

## Как добавить инструмент

1. В подходящем `src/tools/*.js` добавить `export const fooSchema = z.object({... webhook_url: z.string().url().optional()})`
   и `export async function foo({...}) {...}`.
2. Импортировать и зарегистрировать в [index.js](index.js) в нужной секции через `server.tool(...)`.
3. При необходимости обновить счётчик инструментов и список в [README.md](README.md).

## Почта (REST v3) — важные нюансы

- Методы `mail.mailbox.*` и `mail.message.*` — это **REST v3**; вызывать только через
  `client.callV3`, классический `client.call` вернёт `ERROR_METHOD_NOT_FOUND`.
- Требуется scope **`mail`** у вебхука (это НЕ `mailservice`) и коммерческий тариф Bitrix24.
- Официальная документация методов проверяется через MCP-сервер `b24-dev-mcp`
  (инструменты `bitrix-search`, `bitrix-method-details`).

## База знаний (модуль landing) — важные нюансы

Инструменты `b24_kb_*` живут в [src/tools/knowledge-base.js](src/tools/knowledge-base.js).
База знаний — это сайт landing с `TYPE = KNOWLEDGE`, статья — страница, содержимое
статьи — блоки вёрстки.

- Во **все** вызовы `landing.*` нужен верхнеуровневый `scope: "KNOWLEDGE"`. Без него
  `landing.site.getList` молча отдаёт только обычные сайты, а `landing.block.*` /
  `landing.landing.*` возвращают `LANDING_NOT_EXIST`. Инструменты подставляют scope сами.
- У страницы две версии: **черновик** и опубликованная. Правки идут в черновик, ID блоков
  в версиях **разные** — редактировать можно только по ID из черновика.
  Публикация — `landing.landing.publication`.
- `landing.block.updatenodes` **молча игнорирует массивы значений** (вернёт `result: true`,
  контент не изменится). Значения карточек задаются по одному индексным селектором:
  `".landing-block-faq-visible@0"`, `"@1"`.
- Селекторы редактируемых нод перечислены в манифесте блока, который отдаёт
  `landing.block.getcontent` (но не `getlist`). `b24_kb_page_get` с `detail="nodes"`
  сопоставляет манифест с вёрсткой и возвращает готовые селекторы с индексами.
- Разбор HTML блоков — [src/utils/landing-html.js](src/utils/landing-html.js), без внешних
  зависимостей: поддерживаются простые селекторы манифеста (`.class`, `#id`, `tag`).
- Требуется scope **`landing`** («Сайты и магазины») у вебхука и коммерческий тариф.

## База знаний 2.0 (модуль `note`, REST v3) — важные нюансы

Инструменты `b24_kb2_*` живут в [src/tools/knowledge-base-2.js](src/tools/knowledge-base-2.js).
Это **отдельный от landing движок**: база (`collection`) с деревом документов, содержимое —
Markdown одним полем, публикации нет (документ живой сразу). Старые `b24_kb_*` не трогать —
оба движка работают параллельно, базы одного не видны в списках другого.

- Методы `note.*` — **REST v3**, только `client.callV3`. Проверять их наличие через
  v1-интроспекцию бесполезно: `method.get('note.document.add')` отвечает `isExisting: false`
  для рабочего метода.
- Требуется scope **`note`** («База знаний»), выдаётся только руками в интерфейсе. У общего
  вебхука портала его обычно нет, поэтому у инструментов свой вебхук —
  **`B24_NOTE_WEBHOOK`** (`resolveNoteWebhook`), с откатом на `B24_DEFAULT_WEBHOOK`.
  Он же определяет авторство: документы создаются от имени владельца вебхука.
  Ответ 403 `INSUFFICIENTSCOPEEXCEPTION` подменяется на инструкцию, что и где включить.
- **Ссылки на статью в API нет** — ни в одном DTO. Собираем сами:
  `https://{портал}/note/document/{id}/`, иначе модели нечего дать пользователю.
- `select` у `note.document.get` спецификацией объявлен, но **портал его игнорирует**
  (ответ всегда целиком), а неизвестное имя поля роняет вызов. В схеме его нет намеренно.
- Пагинация баз — **курсорная**: `pagination: { limit, afterCursor }` + `nextCursor` в ответе
  (не `page/limit/offset`, как в `mail.*`).
- `note.document.update` заменяет Markdown **целиком**; при конфликте с открытым совместным
  редактором помогает `overwrite: true`.
- Удаления файлов в API **нет** (`note.file.*` — только `add`, `get`, `field.*`), поэтому
  картинку не перезаливать при каждой правке. Вставка двухшаговая: `note.file.add` отдаёт
  `assetMarkdown` (`[[image fileId=…]]`), его нужно вписать в текст отдельным `update`.
- Удаление базы и документа **каскадное**; у `b24_kb2_delete` поэтому обязательный `confirm`.
- Правами через API не управлять: методов доступа нет, раздел по умолчанию виден только
  администраторам.

## Конвенции

- Описания инструментов и параметров (`.describe(...)`) — **на русском**.
- Идентификаторы кода, имена REST-методов и коды полей API (`STAGE_ID`, `WON`, `UF_...`)
  оставлять как есть, не переводить.
- Возвращаемые из обработчиков объекты — единый стиль: поле `portal` + осмысленные ключи.

## Подводные камни

- В http-режиме `registerTools` **передаётся аргументом** в `startHttpServer`, а не
  импортируется из index.js — иначе статический импорт обратно в модуль с top-level await
  создаёт дедлок графа модулей (см. коммит про «http mode startup deadlock»).
- В `http`-режиме allowlist email обязателен — без него в конфиге бросается ошибка.
- OAuth-хранилище (клиенты DCR + access/refresh токены) персистится в файл
  `B24_OAUTH_STORE_PATH` (в Docker — `/data/oauth-state.json` на томе `oauth-data`),
  поэтому токены переживают рестарт. Если путь пуст — работает как раньше, в памяти.

function configuredHosts() {
  const hosts = new Set(
    (process.env.B24_ALLOWED_WEBHOOK_HOSTS || '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );

  for (const raw of [process.env.B24_DEFAULT_WEBHOOK, process.env.B24_NOTE_WEBHOOK]) {
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).hostname.toLowerCase());
    } catch {
      // The normal validator below will return a useful configuration error.
    }
  }
  return hosts;
}

export function validateWebhookUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Webhook URL has an invalid format.');
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Webhook URL must use HTTPS without credentials, query parameters, or fragments.');
  }
  if (url.port && url.port !== '443') {
    throw new Error('Webhook URL may only use the standard HTTPS port.');
  }
  if (!/^\/rest\/\d+\/[^/]+\/?$/.test(url.pathname)) {
    throw new Error('Webhook URL must have the Bitrix24 incoming-webhook path format.');
  }

  const host = url.hostname.toLowerCase();
  if (!configuredHosts().has(host)) {
    throw new Error(
      'Webhook host is not allowed. Configure B24_DEFAULT_WEBHOOK, B24_NOTE_WEBHOOK, ' +
        'or B24_ALLOWED_WEBHOOK_HOSTS.'
    );
  }

  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
}

export function resolveWebhook(webhookParam) {
  const url = webhookParam || process.env.B24_DEFAULT_WEBHOOK;
  if (!url) {
    throw new Error(
      'Не указан webhook_url и не настроен B24_DEFAULT_WEBHOOK. ' +
      'Укажите вебхук в параметре webhook_url или задайте его в настройках MCP-сервера.'
    );
  }
  return validateWebhookUrl(url);
}

// База знаний 2.0 (методы note.*) требует scope `note`, которого у общего вебхука
// портала обычно нет: scope выдаётся только руками в интерфейсе Битрикса. Поэтому у
// неё отдельный вебхук — B24_NOTE_WEBHOOK. Он же задаёт автора правок: документы
// создаются от имени того пользователя, чьим вебхуком сделан вызов.
// Если переменная не задана, работаем общим вебхуком: инструменты b24_kb2_* сами
// объяснят, что делать, если у него не окажется scope.
export function resolveNoteWebhook(webhookParam) {
  const url = webhookParam || process.env.B24_NOTE_WEBHOOK || process.env.B24_DEFAULT_WEBHOOK;
  if (!url) {
    throw new Error(
      'Не указан webhook_url и не настроены B24_NOTE_WEBHOOK / B24_DEFAULT_WEBHOOK. ' +
      'Инструментам Базы знаний 2.0 нужен вебхук со scope «База знаний» (note).'
    );
  }
  return validateWebhookUrl(url);
}

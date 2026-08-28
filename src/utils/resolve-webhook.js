export function resolveWebhook(webhookParam) {
  const url = webhookParam || process.env.B24_DEFAULT_WEBHOOK;
  if (!url) {
    throw new Error(
      'Не указан webhook_url и не настроен B24_DEFAULT_WEBHOOK. ' +
      'Укажите вебхук в параметре webhook_url или задайте его в настройках MCP-сервера.'
    );
  }
  return url;
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
  return url;
}

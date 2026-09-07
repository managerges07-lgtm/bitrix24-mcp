import { z } from 'zod';
import { Bitrix24Client } from '../bitrix24/client.js';
import { Bitrix24Writer } from '../bitrix24/writer.js';
import { applyUserMapping } from '../utils/user-mapping.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';
import { readWorkspaceJson } from '../utils/safe-path.js';

export const applyConfigSchema = z.object({
  config_file: z.string().describe('Путь к JSON-файлу конфигурации для применения'),
  webhook_url: z.string().url().optional().describe('Вебхук целевой инстанции (необязательно, если настроен по умолчанию)'),
  user_mapping_file: z.string().optional().describe('Путь к JSON сопоставления пользователей (для автоматизаций)'),
  confirm: z.literal(true).describe('Подтверждение записи конфигурации в целевой Bitrix24'),
});

export async function applyConfig({ config_file, webhook_url, user_mapping_file, confirm }) {
  if (confirm !== true) throw new Error('Применение конфигурации требует confirm: true.');
  const { data: config } = readWorkspaceJson(config_file);
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const writer = new Bitrix24Writer(client);

  // Порядок применения, определённый в разделе 7.4 документа
  if (config.currencies?.length) {
    await writer.applyCurrencies(config.currencies);
  }

  if (config.entity_types?.spa?.length) {
    await writer.applyEntityTypes(config.entity_types.spa);
  }

  if (config.pipelines && Object.keys(config.pipelines).length) {
    await writer.applyPipelines(config.pipelines);
  }

  if (config.custom_fields) {
    await writer.applyCustomFields(config.custom_fields);
  }

  if (config.product_catalog && !config.product_catalog.error) {
    await writer.applyProductCatalog(config.product_catalog);
  }

  if (config.automations && Object.keys(config.automations).length) {
    const mapped = applyUserMapping(config.automations, user_mapping_file);
    await writer.applyAutomations(config.automations, mapped);
  }

  const report = writer.getReport();

  return {
    source_portal: config.meta?.portal,
    dest_portal: client.portal,
    result: {
      created: report.created.length,
      updated: report.updated.length,
      failed: report.failed.length,
      skipped: report.skipped.length,
    },
    details: report,
    summary: `Применение завершено: ${report.created.length} создано, ${report.updated.length} обновлено, ${report.failed.length} с ошибками, ${report.skipped.length} пропущено`,
  };
}

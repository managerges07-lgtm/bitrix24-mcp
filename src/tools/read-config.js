import { z } from 'zod';
import { Bitrix24Client } from '../bitrix24/client.js';
import { Bitrix24Reader } from '../bitrix24/reader.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';
import { writeWorkspaceJson } from '../utils/safe-path.js';
import { SERVER_VERSION } from '../version.js';

export const readConfigSchema = z.object({
  webhook_url: z.string().url().optional().describe('URL вебхука (опционально, если настроен по умолчанию)'),
  output_file: z.string().optional().describe('Путь для сохранения экспортированного JSON'),
  verbose: z.boolean().optional().default(false),
});

export async function readFullConfig({ webhook_url, output_file, verbose = false }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const reader = new Bitrix24Reader(client);

  const [entityData, pipelines, customFields, automations, productCatalog, users] = await Promise.all([
    reader.readEntityTypes(),
    reader.readPipelines(),
    reader.readCustomFields(),
    reader.readAutomations(),
    reader.readProductCatalog(),
    reader.readUsers(),
  ]);

  const config = {
    meta: {
      exported_at: new Date().toISOString(),
      portal: client.portal,
      mcp_version: SERVER_VERSION,
    },
    entity_types: {
      standard: entityData.standard,
      spa: entityData.spa,
    },
    pipelines,
    custom_fields: customFields,
    automations,
    product_catalog: productCatalog,
    statuses: entityData.statuses,
    currencies: entityData.currencies,
    users,
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultFile = `config_${client.portal}_${timestamp}.json`;
  const filePath = writeWorkspaceJson(output_file, config, { defaultName: defaultFile });

  const summary = {
    portal: client.portal,
    saved_to: filePath,
    entity_types: `${entityData.standard.length} стандартных + ${entityData.spa.length} SPA`,
    pipelines: Object.keys(pipelines).length,
    custom_fields: Object.values(customFields).reduce((a, f) => a + f.length, 0),
    automations: Object.values(automations).reduce((a, r) => a + r.length, 0),
    users: users.length,
    currencies: entityData.currencies.length,
  };

  return verbose ? { ...summary, config } : summary;
}

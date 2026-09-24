import { z } from 'zod';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';

export const connectTestSchema = z.object({
  webhook_url: z.string().url().optional().describe(
    'URL вебхука Bitrix24 только для legacy webhook mode; в OAuth mode параметр запрещён'
  ),
});

export async function connectTest({ webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));

  const [appInfo, currentUser] = await Promise.all([
    client.call('app.info'),
    client.call('profile'),
  ]);

  const profile = currentUser.result;
  const isAdmin = profile?.ADMIN === true || profile?.ADMIN === 'Y';

  return {
    success: true,
    portal: client.portal,
    app_info: appInfo.result,
    user: {
      id: profile?.ID,
      name: `${profile?.NAME} ${profile?.LAST_NAME}`.trim(),
      email: profile?.EMAIL,
      is_admin: isAdmin,
    },
    warning: isAdmin ? null : 'Пользователь подключения Bitrix24 не имеет роли Администратора. Некоторые операции могут завершиться ошибкой.',
  };
}

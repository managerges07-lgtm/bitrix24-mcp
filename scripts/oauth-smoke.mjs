#!/usr/bin/env node

import { Bitrix24Client } from '../src/bitrix24/client.js';
import { getDefaultBitrixOAuthProvider } from '../src/bitrix24/oauth-provider.js';

const provider = getDefaultBitrixOAuthProvider();
const client = new Bitrix24Client({ type: 'oauth', provider });

try {
  const [app, profile] = await Promise.all([
    client.call('app.info'),
    client.call('profile'),
  ]);
  const user = profile.result || {};
  const appInfo = app.result || {};
  process.stdout.write(`${JSON.stringify({
    ok: true,
    portal: client.portal,
    user: {
      id: user.ID,
      name: `${user.NAME || ''} ${user.LAST_NAME || ''}`.trim(),
      is_admin: user.ADMIN === true || user.ADMIN === 'Y',
    },
    application: {
      status: appInfo.STATUS,
      installed: appInfo.INSTALLED,
      version: appInfo.VERSION,
    },
  }, null, 2)}\n`);
} catch (err) {
  process.stderr.write(`Bitrix24 OAuth read-only smoke failed: ${err.message}\n`);
  process.exitCode = 1;
}

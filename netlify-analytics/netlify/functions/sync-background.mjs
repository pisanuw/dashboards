// The actual sync. A background function gets 15 minutes, where a regular
// function gets 10 seconds and a scheduled one 30 -- and a full pass over the
// account takes well over half a minute.

import { runSync } from '../../src/api.js';
import { createStore } from '../../src/store.js';
import { cronSecretOk, json } from '../lib/shared.mjs';

export default async (req) => {
  if (!cronSecretOk(req)) return json({ error: 'forbidden' }, 403);
  const store = await createStore();
  const latest = await runSync({ store });
  const ok = Object.values(latest.sites).filter((s) => s.status === 'ok').length;
  console.log(`Sync finished: ${ok}/${Object.keys(latest.sites).length} projects with analytics.`);
  return json({ ok: true, syncedAt: latest.syncedAt });
};

// No custom path: /.netlify/ is Netlify's own namespace, and the default URL
// /.netlify/functions/sync-background is exactly what we want to call.
export const config = { background: true };

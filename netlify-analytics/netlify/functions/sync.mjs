// Starts a sync on demand (the dashboard's "Sync now" button) and returns
// immediately: a full pass takes longer than a request may.

import { json, triggerBackgroundSync } from '../lib/shared.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  try {
    await triggerBackgroundSync(req);
    return json({ ok: true, started: true, async: true }, 202);
  } catch (err) {
    return json({ error: err.message }, 502);
  }
};

export const config = { path: '/api/sync' };

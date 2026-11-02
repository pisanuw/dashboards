// What the deployed function can actually see: which store it opened, which
// keys are in it, and which settings reached it. The dashboard being empty
// while the data sits in a store is otherwise very hard to tell apart from
// the data not being there at all.

import { BLOBS_STORE, EFFECTIVE_TIMEZONE, STORE_BACKEND } from '../../src/config.js';
import { createStore } from '../../src/store.js';
import { json } from '../lib/shared.mjs';

export default async () => {
  const out = {
    backend: STORE_BACKEND,
    storeName: BLOBS_STORE,
    timezone: EFFECTIVE_TIMEZONE,
    region: process.env.AWS_REGION || null,
    hasToken: Boolean(process.env.NETLIFY_TOKEN || process.env.NETLIFY_AUTH_TOKEN),
    hasCronSecret: Boolean(process.env.CRON_SECRET),
    blobsContext: Boolean(process.env.NETLIFY_BLOBS_CONTEXT),
  };
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({ name: BLOBS_STORE, consistency: 'strong' });
    const { blobs } = await store.list();
    out.keys = blobs.map((b) => b.key);
  } catch (err) {
    out.listError = err.message;
  }
  try {
    const store = await createStore();
    const history = await store.read('history', null);
    out.historyProjects = history ? Object.keys(history.sites || {}).length : null;
  } catch (err) {
    out.readError = err.message;
  }
  return json(out);
};

export const config = { path: '/api/health' };

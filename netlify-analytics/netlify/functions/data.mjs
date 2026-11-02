import { readDashboardData } from '../../src/api.js';
import { createStore } from '../../src/store.js';
import { json } from '../lib/shared.mjs';

export default async () => {
  const store = await createStore();
  // Whether a sync is running lives in another process here, so the dashboard
  // watches latest.syncedAt change instead of asking.
  return json({ ...(await readDashboardData(store)), syncing: false });
};

export const config = { path: '/api/data' };

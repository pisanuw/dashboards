// The dashboard's API, independent of how it is served. src/server.js wraps
// these for the local Node server; netlify/functions/* wrap the same calls so
// the deployed site and a local run cannot drift apart.

import { DASHBOARD, DEMO } from './config.js';
import { EMPTY_HISTORY, sync } from './sync.js';

export function dashboardConfig() {
  return { ...DASHBOARD, demo: DEMO };
}

export async function readDashboardData(store) {
  const [history, latest] = await Promise.all([
    store.read('history', EMPTY_HISTORY),
    store.read('latest', null),
  ]);
  return { history, latest, demo: DEMO };
}

// One sync at a time per process: a second caller joins the one in flight
// rather than starting a competing pass over the same sites.
let inFlight = null;

export function syncing() {
  return Boolean(inFlight);
}

export function runSync(options = {}) {
  inFlight ??= sync(options).finally(() => { inFlight = null; });
  return inFlight;
}

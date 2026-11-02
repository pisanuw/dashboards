// Netlify only serves 30 days of analytics, so a day missed is a day lost.
// This runs daily and hands the work to the background function.
//
// Change the cadence with SYNC_CRON (standard cron, UTC) in netlify.toml.

import { triggerBackgroundSync } from '../lib/shared.mjs';

export default async (req) => {
  const url = await triggerBackgroundSync(req);
  console.log(`Scheduled sync triggered: ${url}`);
};

export const config = { schedule: '@daily' };

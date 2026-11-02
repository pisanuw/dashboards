// Netlify only serves 30 days of analytics, so a day missed is a day lost.
// This runs daily and hands the work to the background function, which gets
// 15 minutes where a scheduled function gets 30 seconds.

import { triggerBackgroundSync } from '../lib/shared.mjs';

export default async (req) => {
  const url = await triggerBackgroundSync(req);
  console.log(`Scheduled sync triggered: ${url}`);
};

// Cron is UTC, always. 08:15 UTC is just past midnight in
// America/Los_Angeles, the zone TZ pins day boundaries to, so each run sees a
// complete previous day; "@daily" would fire mid-afternoon there and every run
// would be counting a day still in progress. Change this when TZ changes.
export const config = { schedule: '15 8 * * *' };

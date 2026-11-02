// Verifies your token against the sites API and the (undocumented) analytics API.
// Usage: npm run check [-- <site-name>]

import { getToken, selectSites } from './config.js';
import { createNetlifyClient } from './netlify.js';
import { tzOffset } from './sync.js';

async function main() {
  const client = createNetlifyClient(getToken());

  const all = await client.listSites();
  const sites = selectSites(all);
  const filtered = all.length - sites.length;
  console.log(`Sites API: OK, ${all.length} sites${filtered ? ` (${filtered} filtered out by SITE_INCLUDE/SITE_EXCLUDE)` : ''}`);
  for (const s of sites) console.log(`  ${s.name}  (${s.id})`);

  const wanted = process.argv[2];
  // Default to a site that has Analytics on, so a healthy token does not look broken.
  const site = wanted ? sites.find((s) => s.name === wanted) : sites.find((s) => s.analyticsInstanceId) || sites[0];
  if (!site) {
    console.error(wanted ? `No site named ${wanted}` : 'No sites in this account');
    return 1;
  }

  const to = Date.now();
  const from = to - 7 * 86_400_000;
  try {
    const data = await client.analytics(site.id, 'pageviews', { from, to, timezone: tzOffset(), resolution: 'day' });
    console.log(`\nAnalytics API for ${site.name}: OK`);
    console.log(JSON.stringify(data, null, 2).slice(0, 1000));
  } catch (err) {
    console.error(`\nAnalytics API for ${site.name} failed: ${err.message}`);
    console.error('If this is 404, Analytics may not be enabled for this site; try another with `npm run check -- <site-name>`.');
    return 1;
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}

// Verifies your token against the sites API and the (undocumented) analytics API.
// Usage: npm run check [-- <site-name>]

import { getToken } from './config.js';
import { createNetlifyClient } from './netlify.js';
import { tzOffset } from './sync.js';

const client = createNetlifyClient(getToken());

const sites = await client.listSites();
console.log(`Sites API: OK, ${sites.length} sites`);
for (const s of sites) console.log(`  ${s.name}  (${s.id})`);

const wanted = process.argv[2];
const site = wanted ? sites.find((s) => s.name === wanted) : sites[0];
if (!site) {
  console.error(`No site named ${wanted}`);
  process.exit(1);
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
  process.exit(1);
}

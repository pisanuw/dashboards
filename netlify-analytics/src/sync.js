// Pulls analytics for every selected Netlify project and merges it into the store.
//
//   history  daily pageviews/visitors/bandwidth per site, kept forever
//            (Netlify only shows 30 days, so history builds up over time)
//   latest   rankings (top pages, sources, ...) from the most recent sync
//
// See src/store.js for where those two documents actually live.

import { fileURLToPath } from 'node:url';
import { CONCURRENCY, DEMO, RANKING_LIMIT, SYNC_DAYS, getToken, selectSites } from './config.js';
import { createStore } from './store.js';
import { createNetlifyClient } from './netlify.js';
import { createMockClient } from './mock.js';

const DAY = 86_400_000;

export const EMPTY_HISTORY = { sites: {}, daily: {} };

export function createClient() {
  return DEMO ? createMockClient() : createNetlifyClient(getToken());
}

// Local UTC offset in the "+HHMM" form the analytics API expects.
export function tzOffset(date = new Date()) {
  const mins = -date.getTimezoneOffset();
  const abs = Math.abs(mins);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${mins >= 0 ? '+' : '-'}${hh}${mm}`;
}

export function dateKey(ts) {
  const ms = ts < 1e12 ? ts * 1000 : ts; // tolerate seconds or milliseconds
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Turns [[timestamp, count], ...] (or [{timestamp|start, count}, ...]) into {date: count}.
function seriesByDate(data, valueKey = 'count') {
  const out = {};
  for (const point of data || []) {
    const [ts, value] = Array.isArray(point)
      ? point
      : [point.timestamp ?? point.start, point[valueKey]];
    if (ts == null) continue;
    const key = dateKey(Number(ts));
    out[key] = (out[key] || 0) + (Number(value) || 0);
  }
  return out;
}

async function fetchSite(client, siteId, window) {
  const { from, to, timezone } = window;
  const q = (extra) => ({ from, to, timezone, ...extra });
  const limit = RANKING_LIMIT;
  const [pageviews, visitors, bandwidth, uniques, pages, sources, countries, notFound] = await Promise.all([
    client.analytics(siteId, 'pageviews', q({ resolution: 'day' })),
    client.analytics(siteId, 'visitors', q({ resolution: 'day' })),
    client.analytics(siteId, 'bandwidth', q({ resolution: 'day' })),
    client.analytics(siteId, 'visitors', q({ resolution: 'range' })),
    client.analytics(siteId, 'ranking/pages', q({ limit })),
    client.analytics(siteId, 'ranking/sources', q({ limit })),
    client.analytics(siteId, 'ranking/countries', q({ limit })),
    client.analytics(siteId, 'ranking/not_found', q({ limit })),
  ]);

  const pv = seriesByDate(pageviews);
  const vis = seriesByDate(visitors);
  const bw = seriesByDate(bandwidth, 'siteBandwidth');
  const daily = {};
  for (const date of new Set([...Object.keys(pv), ...Object.keys(vis), ...Object.keys(bw)])) {
    daily[date] = { pageviews: pv[date] || 0, visitors: vis[date] || 0, bandwidth: bw[date] || 0 };
  }

  const ranked = (rows) => (rows || []).map((r) => ({ resource: r.resource, count: r.count }));
  return {
    daily,
    uniqueVisitors: Object.values(seriesByDate(uniques)).reduce((a, b) => a + b, 0),
    pages: ranked(pages),
    sources: ranked(sources),
    countries: (countries || []).map((r) => ({ resource: r.country_name || r.resource, count: r.count })),
    notFound: ranked(notFound),
  };
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

export async function sync({
  client = createClient(),
  store,
  days = SYNC_DAYS,
  log = console.log,
} = {}) {
  const target = store ?? (await createStore());
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const window = { from: startOfToday.getTime() - (days - 1) * DAY, to: now.getTime(), timezone: tzOffset(now) };

  const all = await client.listSites();
  const sites = selectSites(all);
  const skipped = all.length - sites.length;
  log(`Syncing ${sites.length} sites (last ${days} days)${skipped ? `, ${skipped} filtered out` : ''}...`);

  const history = await target.read('history', EMPTY_HISTORY);
  history.sites ??= {};
  history.daily ??= {};
  const latest = { syncedAt: now.toISOString(), from: window.from, to: window.to, days, sites: {} };

  await mapLimit(sites, CONCURRENCY, async (site) => {
    const meta = { name: site.name, url: site.url, adminUrl: site.adminUrl };
    history.sites[site.id] = meta;
    try {
      const result = await fetchSite(client, site.id, window);
      history.daily[site.id] = { ...history.daily[site.id], ...result.daily };
      const { daily, ...rankings } = result;
      latest.sites[site.id] = { ...meta, status: 'ok', ...rankings };
      log(`  ok       ${site.name}`);
    } catch (err) {
      // 401/403/404 from the analytics service usually means Analytics is not enabled for the site.
      const disabled = [401, 403, 404].includes(err.status);
      latest.sites[site.id] = { ...meta, status: disabled ? 'no-analytics' : 'error', error: err.message };
      log(`  ${disabled ? 'skipped ' : 'ERROR   '} ${site.name}: ${err.message}`);
    }
  });

  await target.write('history', history);
  await target.write('latest', latest);

  const ok = Object.values(latest.sites).filter((s) => s.status === 'ok').length;
  log(`Done: ${ok}/${sites.length} sites with analytics. Data in ${target.describe()}`);
  return latest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sync().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

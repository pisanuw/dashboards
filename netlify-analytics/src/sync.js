// Pulls analytics for every selected Netlify project and merges it into the store.
//
//   history  daily pageviews/visitors/bandwidth per site, kept forever
//            (Netlify only shows 30 days, so history builds up over time)
//   latest   rankings (top pages, sources, ...) from the most recent sync
//
// See src/store.js for where those two documents actually live.

import { fileURLToPath } from 'node:url';
import {
  CONCURRENCY,
  DEMO,
  RANKING_LIMIT,
  SYNC_DAYS,
  SYNC_RETRY_DEADLINE_MS,
  getToken,
  selectSites,
} from './config.js';
import { createStore } from './store.js';
import { createNetlifyClient } from './netlify.js';
import { createMockClient } from './mock.js';

const DAY = 86_400_000;

export const EMPTY_HISTORY = { sites: {}, daily: {} };

export function createClient({ runDeadline = null } = {}) {
  return DEMO ? createMockClient() : createNetlifyClient(getToken(), { runDeadline });
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
  const wanted = [
    ['pageviews', { resolution: 'day' }],
    ['visitors', { resolution: 'day' }],
    ['bandwidth', { resolution: 'day' }],
    ['visitors', { resolution: 'range' }],
    ['ranking/pages', { limit }],
    ['ranking/sources', { limit }],
    ['ranking/countries', { limit }],
    ['ranking/not_found', { limit }],
  ];
  // One endpoint at a time, not Promise.all. Eight at once per project times
  // CONCURRENCY projects is a 32-request spike, and the spike is what trips the
  // throttle; this keeps the requests in flight down to CONCURRENCY. It costs
  // wall-clock on a healthy run and buys a run that finishes at all on a
  // throttled one.
  const answers = [];
  for (const [endpoint, extra] of wanted) answers.push(await client.analytics(siteId, endpoint, q(extra)));
  const [pageviews, visitors, bandwidth, uniques, pages, sources, countries, notFound] = answers;

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
  client,
  store,
  days = SYNC_DAYS,
  log = console.log,
} = {}) {
  const target = store ?? (await createStore());
  const now = new Date();
  // Built here rather than in the default parameter so it can carry the run's
  // own deadline, which is only known once the run has a start time.
  client ||= createClient({ runDeadline: now.getTime() + SYNC_RETRY_DEADLINE_MS });
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

  let withAnalyticsOff = 0;
  await mapLimit(sites, CONCURRENCY, async (site) => {
    const meta = { name: site.name, url: site.url, adminUrl: site.adminUrl };
    history.sites[site.id] = meta;

    // Whether a project has Analytics on is a property of the site record --
    // the API sets analytics_instance_id when the add-on is provisioned -- not
    // something to infer from how the analytics service answers. Inferring it
    // from a 401 filed throttled projects as "Analytics off", which is both
    // wrong on the dashboard and silent: 28 of 89 projects were reported off on
    // 2026-11-11 while 88 of them had it on. Checking the field also saves the
    // 8 requests a project with Analytics off would otherwise spend, which is 8
    // fewer chances to trip the throttle for everyone else.
    if (!site.analyticsInstanceId) {
      latest.sites[site.id] = { ...meta, status: 'no-analytics' };
      withAnalyticsOff++;
      log(`  off      ${site.name}: Analytics is not enabled`);
      return;
    }

    try {
      const result = await fetchSite(client, site.id, window);
      history.daily[site.id] = { ...history.daily[site.id], ...result.daily };
      const { daily, ...rankings } = result;
      latest.sites[site.id] = { ...meta, status: 'ok', ...rankings };
      log(`  ok       ${site.name}`);
    } catch (err) {
      // Analytics is on for this project, so a failure here is a failure to
      // read it -- a real error to surface, never a quiet "no analytics".
      latest.sites[site.id] = { ...meta, status: 'error', error: err.message };
      log(`  ERROR    ${site.name}: ${err.message}`);
    }
  });

  const { retries = 0, retriedRequests = 0, throttle } = client.stats || {};
  // Recorded on the document, not only logged: the last run's throttling is
  // what explains a project missing from the dashboard, and digging it out of
  // function logs afterwards does not work -- they do not keep the output.
  // Set before the write, or the store gets a document without it -- which is
  // what shipped on 2026-11-11 and left a clean deployed run indistinguishable
  // from one that had been throttled all the way through.
  latest.throttle = { retries, retriedRequests, ...throttle };

  await target.write('history', history);
  await target.write('latest', latest);

  const ok = Object.values(latest.sites).filter((s) => s.status === 'ok').length;
  const failed = Object.values(latest.sites).filter((s) => s.status === 'error').length;
  if (retries || throttle?.trips) {
    log(`Throttled: ${throttle?.trips || 0} pause(s), ${Math.round((throttle?.pausedMs || 0) / 1000)}s waiting in total, ` +
      `${retriedRequests} request(s) retried.`);
  }
  log(
    `Done: ${ok}/${sites.length - withAnalyticsOff} sites with analytics read` +
    `${withAnalyticsOff ? `, ${withAnalyticsOff} with Analytics off` : ''}` +
    `${failed ? `, ${failed} FAILED` : ''}. Data in ${target.describe()}`,
  );
  return latest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sync().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

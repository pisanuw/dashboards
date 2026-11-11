/* The dashboard's statistics, computed in one place.
 *
 * The page (public/app.js) renders these numbers and src/export.js writes them
 * to JSON, which is the whole reason this file exists: an export that computed
 * its own totals would sooner or later disagree with the screen it claims to
 * describe. Same motive as src/api.js, one layer up.
 *
 * Nothing here touches the DOM or Node, and it lives under public/ so the
 * browser can fetch it and Node can import it by path.
 */

export const SERIES_COLORS = 16; // --series-1..16 in style.css; extra projects fold into "Other"

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// Highest-count entry of a ranking list, or null when there is nothing in it.
export const topRow = (rows) => (rows || []).reduce((best, r) => (!best || r.count > best.count ? r : best), null);

// A range of 0 days means "everything we have".
export const toDays = (n) => (Number(n) > 0 ? Number(n) : Infinity);

export function rangeLabel(days) {
  if (!Number.isFinite(days)) return 'All';
  if (days % 365 === 0) return `${days / 365}y`;
  return `${days}d`;
}

// Dates are local "YYYY-MM-DD" keys, matching the sync script.
export function keyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return keyOf(d);
}
export function daysBetween(a, b) {
  return Math.round((parseKey(b) - parseKey(a)) / 86_400_000);
}
export function weekStart(key) {
  const d = parseKey(key);
  return addDays(key, -((d.getDay() + 6) % 7));
}

// Everything the dashboard draws, for one date range and one set of hidden
// projects. `weeklyAfterDays` only decides how daily points are grouped for the
// charts; pass Infinity to keep every day separate, which is what an export
// wants.
export function buildModel({ history, latest }, { range = Infinity, hidden = new Set(), weeklyAfterDays = 92 } = {}) {
  const daily = history.daily;
  const allIds = Object.keys(history.sites).filter((id) => daily[id] && Object.keys(daily[id]).length);

  // Color follows the project, fixed by all-time pageviews so filters never repaint survivors.
  const allTime = (id) => sum(Object.values(daily[id]).map((d) => d.pageviews));
  const ordered = [...allIds].sort((a, b) => allTime(b) - allTime(a));
  const slots = ordered.length <= SERIES_COLORS ? SERIES_COLORS : SERIES_COLORS - 1;
  const colorVar = {};
  ordered.forEach((id, i) => { colorVar[id] = i < slots ? `--series-${i + 1}` : '--series-other'; });

  const visible = ordered.filter((id) => !hidden.has(id));

  const today = keyOf(new Date());
  const allDates = allIds.flatMap((id) => Object.keys(daily[id])).sort();
  const earliest = allDates[0] || today;
  const wantStart = Number.isFinite(range) ? addDays(today, -(range - 1)) : earliest;
  const start = wantStart < earliest ? earliest : wantStart;
  const span = daysBetween(start, today) + 1;

  const dates = [];
  for (let k = start; k <= today; k = addDays(k, 1)) dates.push(k);

  const weekly = span > weeklyAfterDays;
  const bucketOf = weekly ? weekStart : (k) => k;
  const buckets = [...new Set(dates.map(bucketOf))];
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

  const metric = (id, key, from, to) => {
    let total = 0;
    for (const [date, d] of Object.entries(daily[id] || {})) if (date >= from && date <= to) total += d[key];
    return total;
  };
  const series = (id, key) => {
    const out = new Array(buckets.length).fill(0);
    for (const date of dates) {
      const d = daily[id][date];
      if (d) out[bucketIndex.get(bucketOf(date))] += d[key];
    }
    return out;
  };

  // Sorted by pageviews so the stacked chart's series order is stable; the
  // Projects table sorts its own copy.
  const perSite = visible.map((id) => {
    const pageviews = metric(id, 'pageviews', start, today);
    const visitors = metric(id, 'visitors', start, today);
    const site = latest?.sites?.[id];
    return {
      id,
      ...history.sites[id],
      colorVar: colorVar[id],
      pageviews,
      visitors,
      bandwidth: metric(id, 'bandwidth', start, today),
      perVisitor: visitors > 0 ? pageviews / visitors : null,
      // The four ranking fields below come from the last sync's 30-day window,
      // which is all Netlify serves, so they do not follow the date range.
      topPage: topRow(site?.pages),
      topSource: topRow(site?.sources),
      topCountry: topRow(site?.countries),
      notFound: site?.notFound ? sum(site.notFound.map((r) => r.count)) : null,
      latest: site,
    };
  }).sort((a, b) => b.pageviews - a.pageviews);

  // Previous period of equal length, only when history fully covers it.
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(start, -span);
  const hasPrev = prevStart >= earliest;
  const totals = (from, to) => ({
    pageviews: sum(visible.map((id) => metric(id, 'pageviews', from, to))),
    visitors: sum(visible.map((id) => metric(id, 'visitors', from, to))),
    bandwidth: sum(visible.map((id) => metric(id, 'bandwidth', from, to))),
  });

  return {
    ordered, visible, colorVar, perSite, weekly, buckets, dates, series, span, start, end: today, earliest,
    totals: totals(start, today),
    prev: hasPrev ? { ...totals(prevStart, prevEnd), start: prevStart, end: prevEnd } : null,
  };
}

// ---------- export document ----------

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
const rankRow = (r) => ({ resource: r.resource, count: r.count });

// Ranking rows that belong to one project each (pages, 404s): a path means
// nothing without the project it is on, so they are listed, not merged.
function perProjectRows(sites, key) {
  return sites
    .flatMap((s) => (s.latest[key] || []).map((r) => ({ resource: r.resource, project: s.name, count: r.count })))
    .sort((a, b) => b.count - a.count);
}

// Ranking rows that mean the same thing everywhere (sources, countries): added
// up across projects, as the dashboard's top lists show them.
function mergedRows(sites, key) {
  const map = new Map();
  for (const s of sites) {
    for (const r of s.latest[key] || []) {
      const e = map.get(r.resource) || { resource: r.resource, count: 0, projects: [] };
      e.count += r.count;
      e.projects.push(s.name);
      map.set(r.resource, e);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * Everything the dashboard knows, as one JSON-serialisable document: the
 * totals, the per-project table, every day in the range, and the rankings.
 *
 * The range and the hidden projects are the ones asked for, so an export taken
 * from the page matches the page. Days are never grouped into weeks here --
 * that is a charting concern, and an export should not lose resolution.
 */
export function buildExport({ history, latest, demo = false }, {
  range = Infinity,
  hidden = new Set(),
  timezone = '',
  timezonePinned = false,
  generatedAt = new Date(),
} = {}) {
  const model = buildModel({ history, latest }, { range, hidden, weeklyAfterDays: Infinity });
  const sites = latest?.sites || {};
  const withAnalytics = model.perSite.filter((s) => s.latest?.status === 'ok');
  const shareOf = Math.max(1, model.totals.pageviews);

  // Dense: every day in the range for every project, zeros included, so the
  // rows line up without a join on the consumer's side.
  const dayTotals = model.dates.map((date) => {
    const row = { date, pageviews: 0, visitors: 0, bandwidth: 0 };
    for (const s of model.perSite) {
      const d = history.daily[s.id]?.[date];
      if (d) { row.pageviews += d.pageviews; row.visitors += d.visitors; row.bandwidth += d.bandwidth; }
    }
    return row;
  });

  return {
    format: 'netlify-analytics-export/1',
    generatedAt: generatedAt.toISOString(),
    source: {
      syncedAt: latest?.syncedAt ?? null,
      timezone,
      timezonePinned,
      demo,
      // Rankings are whatever Netlify served at the last sync and cannot follow
      // the range: 30 days is all the API offers.
      rankingWindowDays: latest?.days ?? null,
    },
    range: {
      label: rangeLabel(range),
      requestedDays: Number.isFinite(range) ? range : null,
      start: model.start,
      end: model.end,
      days: model.span,
      // A requested range longer than the history is served short, not padded.
      truncatedToHistory: Number.isFinite(range) && model.span < range,
      historyStarts: model.earliest,
    },
    filters: {
      projectsIncluded: model.visible.length,
      projectsHidden: model.ordered.filter((id) => hidden.has(id)).map((id) => history.sites[id].name),
    },
    totals: {
      ...model.totals,
      projectsWithTraffic: model.perSite.filter((s) => s.pageviews > 0).length,
      projectsIncluded: model.visible.length,
    },
    previousPeriod: model.prev && {
      start: model.prev.start,
      end: model.prev.end,
      pageviews: model.prev.pageviews,
      visitors: model.prev.visitors,
      bandwidth: model.prev.bandwidth,
      changePercent: {
        pageviews: pct(model.totals.pageviews, model.prev.pageviews),
        visitors: pct(model.totals.visitors, model.prev.visitors),
        bandwidth: pct(model.totals.bandwidth, model.prev.bandwidth),
      },
    },
    daily: dayTotals,
    projects: model.perSite.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url ?? null,
      adminUrl: s.adminUrl ?? null,
      status: s.latest?.status ?? 'unknown',
      pageviews: s.pageviews,
      visitors: s.visitors,
      bandwidth: s.bandwidth,
      viewsPerVisitor: round1(s.perVisitor),
      sharePercent: Math.round((s.pageviews / shareOf) * 1000) / 10,
      // The four below are the last sync's 30-day window, not the range above.
      topPage: s.topPage ? rankRow(s.topPage) : null,
      topSource: s.topSource ? rankRow(s.topSource) : null,
      topCountry: s.topCountry ? rankRow(s.topCountry) : null,
      notFound: s.notFound,
      daily: model.dates.map((date) => ({
        date,
        ...(history.daily[s.id]?.[date] ?? { pageviews: 0, visitors: 0, bandwidth: 0 }),
      })),
      rankings: s.latest?.status === 'ok' ? {
        pages: (s.latest.pages || []).map(rankRow),
        sources: (s.latest.sources || []).map(rankRow),
        countries: (s.latest.countries || []).map(rankRow),
        notFound: (s.latest.notFound || []).map(rankRow),
      } : null,
    })),
    rankings: {
      windowDays: latest?.days ?? null,
      asOf: latest?.syncedAt ?? null,
      pages: perProjectRows(withAnalytics, 'pages'),
      sources: mergedRows(withAnalytics, 'sources'),
      countries: mergedRows(withAnalytics, 'countries'),
      notFound: perProjectRows(withAnalytics, 'notFound'),
    },
    excluded: {
      // Listed from the sync, not the range, so a project missing from the
      // numbers above can always be accounted for.
      noAnalytics: Object.values(sites).filter((s) => s.status === 'no-analytics').map((s) => s.name),
      errors: Object.values(sites).filter((s) => s.status === 'error').map((s) => ({ name: s.name, error: s.error })),
    },
  };
}

/* global Chart */

const SERIES_COLORS = 16; // --series-1..16 in style.css; extra projects fold into "Other"

// Everything below comes from /api/config, which the server builds from
// environment variables. These are the values used if that call fails, so the
// dashboard still renders rather than showing nothing.
const FALLBACK_CONFIG = {
  title: 'Netlify Analytics',
  ranges: [7, 30, 90, 365, 0],
  defaultRange: 30,
  rankRows: 10,
  weeklyAfterDays: 92,
  timezone: '',
};

// A range of 0 days means "everything we have".
function rangeLabel(days) {
  if (!Number.isFinite(days)) return 'All';
  if (days % 365 === 0) return `${days / 365}y`;
  return `${days}d`;
}
const toDays = (n) => (Number(n) > 0 ? Number(n) : Infinity);

let CONFIG = FALLBACK_CONFIG;
let RANGES = [];
let RANK_ROWS = FALLBACK_CONFIG.rankRows;
let WEEKLY_AFTER_DAYS = FALLBACK_CONFIG.weeklyAfterDays;

function applyConfig(cfg) {
  CONFIG = { ...FALLBACK_CONFIG, ...cfg };
  RANGES = CONFIG.ranges.map((d) => ({ days: toDays(d), label: rangeLabel(toDays(d)) }));
  if (!RANGES.length) RANGES = FALLBACK_CONFIG.ranges.map((d) => ({ days: toDays(d), label: rangeLabel(toDays(d)) }));
  RANK_ROWS = CONFIG.rankRows;
  WEEKLY_AFTER_DAYS = CONFIG.weeklyAfterDays;

  document.title = CONFIG.title;
  $('title').textContent = CONFIG.title;

  // A stored range from a previous visit only counts if it is still offered.
  const saved = ((r) => (r === 'all' ? Infinity : r))(stored('range', null));
  const offered = RANGES.map((r) => r.days);
  state.range = offered.includes(saved) ? saved : (offered.includes(toDays(CONFIG.defaultRange)) ? toDays(CONFIG.defaultRange) : offered[0]);
}

const $ = (id) => document.getElementById(id);
const DEFAULT_SORT = { key: 'pageviews', dir: -1 };
const state = {
  data: null,
  range: 30,
  hidden: new Set(stored('hidden', [])),
  sort: stored('sort', DEFAULT_SORT),
  charts: {},
};

// ---------- small helpers ----------

function stored(key, fallback) {
  try {
    const v = localStorage.getItem(`netlify-analytics:${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try { localStorage.setItem(`netlify-analytics:${key}`, JSON.stringify(value)); } catch { /* ignore */ }
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// Highest-count entry of a ranking list, or null when there is nothing in it.
const topRow = (rows) => (rows || []).reduce((best, r) => (!best || r.count > best.count ? r : best), null);
const fmtInt = (n) => Math.round(n).toLocaleString();
function fmtShort(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}
function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
function fmtAgo(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// Dates are local "YYYY-MM-DD" keys, matching the sync script.
function keyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return keyOf(d);
}
function daysBetween(a, b) {
  return Math.round((parseKey(b) - parseKey(a)) / 86_400_000);
}
function weekStart(key) {
  const d = parseKey(key);
  return addDays(key, -((d.getDay() + 6) % 7));
}
const fmtDay = (key) => parseKey(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// ---------- model ----------

function buildModel() {
  const { history, latest } = state.data;
  const daily = history.daily;
  const allIds = Object.keys(history.sites).filter((id) => daily[id] && Object.keys(daily[id]).length);

  // Color follows the project, fixed by all-time pageviews so filters never repaint survivors.
  const allTime = (id) => sum(Object.values(daily[id]).map((d) => d.pageviews));
  const ordered = [...allIds].sort((a, b) => allTime(b) - allTime(a));
  const slots = ordered.length <= SERIES_COLORS ? SERIES_COLORS : SERIES_COLORS - 1;
  const colorVar = {};
  ordered.forEach((id, i) => { colorVar[id] = i < slots ? `--series-${i + 1}` : '--series-other'; });

  const visible = ordered.filter((id) => !state.hidden.has(id));

  const today = keyOf(new Date());
  const allDates = allIds.flatMap((id) => Object.keys(daily[id])).sort();
  const earliest = allDates[0] || today;
  const wantStart = Number.isFinite(state.range) ? addDays(today, -(state.range - 1)) : earliest;
  const start = wantStart < earliest ? earliest : wantStart;
  const span = daysBetween(start, today) + 1;

  const dates = [];
  for (let k = start; k <= today; k = addDays(k, 1)) dates.push(k);

  const weekly = span > WEEKLY_AFTER_DAYS;
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
    ordered, visible, colorVar, perSite, weekly, buckets, series, span, start, earliest,
    totals: totals(start, today),
    prev: hasPrev ? totals(prevStart, prevEnd) : null,
  };
}

// ---------- rendering ----------

function renderFilters(model) {
  const range = $('range');
  range.replaceChildren(...RANGES.map((r) => el('button', {
    type: 'button',
    'aria-pressed': String(r.days === state.range),
    onclick: () => { state.range = r.days; store('range', Number.isFinite(r.days) ? r.days : 'all'); render(); },
  }, r.label)));

  const chips = model.ordered.map((id) => el('button', {
    type: 'button',
    'aria-pressed': String(!state.hidden.has(id)),
    title: state.hidden.has(id) ? 'Show' : 'Hide',
    onclick: () => {
      if (state.hidden.has(id)) state.hidden.delete(id); else state.hidden.add(id);
      store('hidden', [...state.hidden]);
      render();
    },
  }, el('span', { class: 'swatch', style: { background: `var(${model.colorVar[id]})` } }), state.data.history.sites[id].name));

  if (model.ordered.length > 1) {
    const allShown = state.hidden.size === 0;
    chips.push(el('button', {
      type: 'button',
      class: 'link',
      onclick: () => {
        state.hidden = allShown ? new Set(model.ordered) : new Set();
        store('hidden', [...state.hidden]);
        render();
      },
    }, allShown ? 'Hide all' : 'Show all'));
  }
  $('sites').replaceChildren(...chips);
}

function renderKpis(model) {
  const periodLabel = Number.isFinite(state.range) && model.span === state.range ? `previous ${model.span} days` : 'previous period';
  const tile = (label, value, cur, prev, fmt) => {
    let delta = el('div', { class: 'delta' }, ' ');
    if (prev != null && prev > 0) {
      const pct = ((cur - prev) / prev) * 100;
      const up = pct >= 0;
      delta = el('div', { class: `delta${up ? ' up' : ''}` },
        `${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}% vs ${periodLabel} (${fmt(prev)})`);
    }
    return el('div', { class: 'kpi' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), delta);
  };
  const { totals, prev } = model;
  const withData = model.perSite.filter((s) => s.pageviews > 0).length;
  $('kpis').replaceChildren(
    tile('Pageviews', fmtInt(totals.pageviews), totals.pageviews, prev?.pageviews, fmtInt),
    tile('Visitors', fmtInt(totals.visitors), totals.visitors, prev?.visitors, fmtInt),
    tile('Bandwidth', fmtBytes(totals.bandwidth), totals.bandwidth, prev?.bandwidth, fmtBytes),
    el('div', { class: 'kpi' },
      el('div', { class: 'label' }, 'Projects with traffic'),
      el('div', { class: 'value' }, `${withData}`),
      el('div', { class: 'delta' }, `of ${model.visible.length} shown`)),
  );
}

const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.();
    if (!active?.length || chart.config.type !== 'line') return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.strokeStyle = cssVar('--baseline');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(active[0].element.x, chartArea.top);
    ctx.lineTo(active[0].element.x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function baseOptions(model, { stacked = false, fmt = fmtInt, axisFmt = fmtShort } = {}) {
  const muted = cssVar('--text-muted');
  const labels = model.buckets.map((b) => (model.weekly ? `Week of ${fmtDay(b)}` : fmtDay(b)));
  return {
    labels,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          stacked,
          grid: { display: false },
          border: { color: cssVar('--baseline') },
          ticks: {
            color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 8,
            callback: (_, i) => (model.weekly ? fmtDay(model.buckets[i]) : labels[i]),
          },
        },
        y: {
          stacked,
          beginAtZero: true,
          grid: { color: cssVar('--grid') },
          border: { display: false },
          ticks: { color: muted, maxTicksLimit: 5, callback: axisFmt },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar('--surface-1'),
          borderColor: cssVar('--border'),
          borderWidth: 1,
          titleColor: cssVar('--text-secondary'),
          bodyColor: cssVar('--text-primary'),
          footerColor: cssVar('--text-primary'),
          padding: 10,
          boxWidth: 10,
          boxHeight: 2,
          filter: (item) => item.parsed.y > 0 || !stacked,
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
          callbacks: {
            label: (c) => `${fmt(c.parsed.y)}   ${c.dataset.label}`,
            labelColor: (c) => ({ borderColor: c.dataset.borderColor, backgroundColor: c.dataset.backgroundColor }),
            footer: stacked ? (items) => `${fmt(sum(items.map((i) => i.parsed.y)))}   Total` : undefined,
          },
        },
      },
    },
  };
}

function chart(id, config) {
  state.charts[id]?.destroy();
  state.charts[id] = new Chart($(id), { ...config, plugins: [crosshair] });
}

function renderCharts(model) {
  const surface = cssVar('--surface-1');

  // Stacked pageviews: one dataset per project; past SERIES_COLORS projects the tail folds into "Other".
  const groups = [];
  const other = new Array(model.buckets.length).fill(0);
  for (const s of model.perSite) {
    const values = model.series(s.id, 'pageviews');
    if (model.colorVar[s.id] === '--series-other') values.forEach((v, i) => { other[i] += v; });
    else groups.push({ label: s.name, values, color: cssVar(model.colorVar[s.id]) });
  }
  if (other.some((v) => v > 0)) groups.push({ label: 'Other projects', values: other, color: cssVar('--series-other') });

  const pv = baseOptions(model, { stacked: true });
  pv.options.plugins.legend = {
    display: groups.length > 1,
    position: 'top',
    align: 'start',
    labels: { color: cssVar('--text-secondary'), boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 },
  };
  chart('pvChart', {
    type: 'bar',
    data: {
      labels: pv.labels,
      datasets: groups.map((g) => ({
        label: g.label,
        data: g.values,
        backgroundColor: g.color,
        borderColor: surface,
        borderWidth: { top: 2 },
        borderRadius: 4,
        categoryPercentage: 0.85,
        barPercentage: 0.9,
      })),
    },
    options: pv.options,
  });

  const line = (id, key, label, fmt, axisFmt) => {
    const totals = new Array(model.buckets.length).fill(0);
    for (const s of model.perSite) model.series(s.id, key).forEach((v, i) => { totals[i] += v; });
    const color = cssVar('--series-1');
    const cfg = baseOptions(model, { fmt, axisFmt });
    chart(id, {
      type: 'line',
      data: {
        labels: cfg.labels,
        datasets: [{
          label, data: totals, borderColor: color, backgroundColor: color, borderWidth: 2,
          pointRadius: 0, pointHoverRadius: 4, pointHoverBorderColor: surface, pointHoverBorderWidth: 2, tension: 0,
        }],
      },
      options: cfg.options,
    });
  };
  line('visChart', 'visitors', 'Visitors', fmtInt, fmtShort);
  line('bwChart', 'bandwidth', 'Bandwidth', fmtBytes, fmtBytes);
}

// A cell for one of the ranking features. `blank` is what an empty resource
// means for that feature: no source is direct traffic, nothing else has a name.
function rankCell(row, blank) {
  if (!row) return el('td', { class: 'trunc' }, el('span', { class: 'muted' }, '—'));
  const what = row.resource || blank;
  return el('td', { class: 'trunc', title: `${what} · ${fmtInt(row.count)} in the last 30 days` }, what);
}

const numCell = (value, fmt) => el('td', { class: 'num' },
  value == null ? el('span', { class: 'muted' }, '—') : fmt(value));

// One column per analytics feature the sync tracks. `window30` marks the four
// that come from the latest sync's 30-day rankings, so they cannot follow the
// date range the way the daily metrics do. `sort` overrides the sort key when
// the cell shows something other than a plain comparable value.
const TABLE_COLUMNS = [
  {
    key: 'name', label: 'Project', type: 'text',
    sort: (s) => s.name.toLowerCase(),
    cell: (s) => el('td', { class: 'name' },
      el('span', { class: 'swatch', style: { background: `var(${s.colorVar})` } }),
      s.url ? el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.name) : s.name),
  },
  {
    key: 'pageviews', label: 'Pageviews', cls: 'num', type: 'num',
    cell: (s) => numCell(s.pageviews, fmtInt),
  },
  {
    key: 'share', label: 'Share', cls: 'share', type: 'num',
    sort: (s) => s.pageviews,
    cell: (s, { max, total }) => el('td', {
      class: 'share',
      title: `${((s.pageviews / total) * 100).toFixed(1)}% of the pageviews shown`,
    }, el('div', { class: 'share-bar' },
      el('span', { style: { width: `${(s.pageviews / max) * 100}%`, background: `var(${s.colorVar})` } }))),
  },
  {
    key: 'visitors', label: 'Visitors', cls: 'num', type: 'num',
    cell: (s) => numCell(s.visitors, fmtInt),
  },
  {
    key: 'perVisitor', label: 'Views/visitor', cls: 'num', type: 'num',
    cell: (s) => numCell(s.perVisitor, (v) => v.toFixed(1)),
  },
  {
    key: 'bandwidth', label: 'Bandwidth', cls: 'num', type: 'num',
    cell: (s) => numCell(s.bandwidth, fmtBytes),
  },
  {
    key: 'topPage', label: 'Top page', cls: 'trunc', type: 'text', window30: true,
    sort: (s) => s.topPage?.resource?.toLowerCase(),
    cell: (s) => rankCell(s.topPage, '(unnamed)'),
  },
  {
    key: 'topSource', label: 'Top source', cls: 'trunc', type: 'text', window30: true,
    sort: (s) => (s.topSource ? (s.topSource.resource || 'direct').toLowerCase() : null),
    cell: (s) => rankCell(s.topSource, '(direct)'),
  },
  {
    key: 'topCountry', label: 'Top country', cls: 'trunc', type: 'text', window30: true,
    sort: (s) => s.topCountry?.resource?.toLowerCase(),
    cell: (s) => rankCell(s.topCountry, '(unknown)'),
  },
  {
    key: 'notFound', label: '404s', cls: 'num', type: 'num', window30: true,
    cell: (s) => numCell(s.notFound, fmtInt),
  },
];

const sortValue = (col, s) => (col.sort ? col.sort(s) : s[col.key]);
const isBlank = (v) => v == null || v === '';

function sortRows(rows, col, dir) {
  return [...rows].sort((a, b) => {
    const va = sortValue(col, a);
    const vb = sortValue(col, b);
    // Projects with nothing in this column stay at the bottom either way round.
    if (isBlank(va) || isBlank(vb)) {
      if (isBlank(va) && isBlank(vb)) return b.pageviews - a.pageviews;
      return isBlank(va) ? 1 : -1;
    }
    const cmp = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb));
    return cmp * dir || b.pageviews - a.pageviews || a.name.localeCompare(b.name);
  });
}

function renderTable(model) {
  const active = TABLE_COLUMNS.find((c) => c.key === state.sort?.key)
    || TABLE_COLUMNS.find((c) => c.key === DEFAULT_SORT.key);
  const dir = state.sort?.dir === 1 ? 1 : -1;
  const ctx = {
    max: Math.max(1, ...model.perSite.map((s) => s.pageviews)),
    total: Math.max(1, model.totals.pageviews),
  };

  const head = el('tr', {}, ...TABLE_COLUMNS.map((col) => {
    const on = col === active;
    return el('th', {
      scope: 'col',
      class: [col.cls, on ? 'sorted' : null].filter(Boolean).join(' ') || null,
      'aria-sort': on ? (dir === 1 ? 'ascending' : 'descending') : 'none',
    }, el('button', {
      type: 'button',
      class: 'sort',
      title: col.window30
        ? `${col.label}: last 30 days as of the latest sync, not the selected range`
        : `Sort by ${col.label.toLowerCase()}`,
      onclick: () => {
        // Same column flips direction; a new one starts high-to-low for numbers, A-Z for text.
        state.sort = on ? { key: col.key, dir: -dir } : { key: col.key, dir: col.type === 'num' ? -1 : 1 };
        store('sort', state.sort);
        renderTable(model);
      },
    }, col.label,
      col.window30 ? el('span', { class: 'col-note' }, '30d') : null,
      el('span', { class: 'arrow', 'aria-hidden': 'true' }, on ? (dir === 1 ? '▲' : '▼') : '')));
  }));

  const rows = sortRows(model.perSite, active, dir)
    .map((s) => el('tr', {}, ...TABLE_COLUMNS.map((col) => col.cell(s, ctx))));

  $('siteTable').replaceChildren(el('thead', {}, head), el('tbody', {}, rows));

  const label = RANGES.find((r) => r.days === state.range)?.label ?? `${model.span} days`;
  $('tableNote').textContent = `One row per project, sortable by any column. Pageviews, share, visitors, `
    + `views/visitor and bandwidth cover the ${label} range; the columns marked 30d come from the latest `
    + `sync and do not follow it.`;
}

function renderRanks(model) {
  const ok = model.perSite.filter((s) => s.latest?.status === 'ok');
  const days = state.data.latest?.days ?? 30;
  $('rankNote').textContent = `last ${days} days as of the latest sync, all date ranges`;

  const perSiteRows = (key) => ok.flatMap((s) => (s.latest[key] || []).map((r) => ({ what: r.resource, sub: s.name, count: r.count })));
  const merged = (key) => {
    const map = new Map();
    for (const s of ok) {
      for (const r of s.latest[key] || []) {
        const e = map.get(r.resource) || { what: r.resource, count: 0, sites: new Set() };
        e.count += r.count;
        e.sites.add(s.name);
        map.set(r.resource, e);
      }
    }
    return [...map.values()].map((e) => ({
      what: e.what, count: e.count, sub: e.sites.size > 1 ? `${e.sites.size} projects` : [...e.sites][0],
    }));
  };

  const fill = (id, rows, showSub = true) => {
    const top = rows.sort((a, b) => b.count - a.count).slice(0, RANK_ROWS);
    const max = Math.max(1, ...top.map((r) => r.count));
    $(id).replaceChildren(...(top.length ? top.map((r) => el('li', {},
      el('span', { class: 'what', title: r.what }, r.what || '(direct)', showSub && r.sub ? el('span', { class: 'sub' }, r.sub) : null),
      el('span', { class: 'count' }, fmtInt(r.count)),
      el('span', { class: 'bar', style: { width: `${(r.count / max) * 100}%` } }),
    )) : [el('li', {}, el('span', { class: 'none' }, 'No data'))]));
  };

  fill('rankPages', perSiteRows('pages'));
  fill('rankSources', merged('sources'));
  fill('rankCountries', merged('countries'), false);
  fill('rankNotFound', perSiteRows('notFound'));
}

function renderNotes(model) {
  const sites = Object.values(state.data.latest?.sites || {});
  const skipped = sites.filter((s) => s.status === 'no-analytics').map((s) => s.name);
  const errors = sites.filter((s) => s.status === 'error');
  const notes = [];
  if (model.earliest > addDays(keyOf(new Date()), -(state.range - 1)) && Number.isFinite(state.range)) {
    notes.push(`History starts ${fmtDay(model.earliest)}. Netlify keeps 30 days, so longer ranges fill in as daily syncs accumulate.`);
  }
  if (CONFIG.timezone) {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Worth saying only when the two disagree: that is when a "day" on this
    // screen and a "day" in the stored data are different spans of time.
    if (here !== CONFIG.timezone) {
      notes.push(`Days are counted in ${CONFIG.timezone}${CONFIG.timezonePinned ? '' : ' (the server\u2019s own setting, not pinned)'}; your browser is in ${here}.`);
    } else if (!CONFIG.timezonePinned) {
      notes.push(`Days are counted in ${CONFIG.timezone}, the server\u2019s own setting. Pin TZ to keep that stable across machines.`);
    }
  }
  if (skipped.length) notes.push(`No analytics data (Analytics not enabled?): ${skipped.join(', ')}`);
  for (const e of errors) notes.push(`Error syncing ${e.name}: ${e.error}`);
  $('notes').replaceChildren(...notes.map((n) => el('p', {}, n)));
}

function render() {
  const { latest, demo } = state.data;
  const total = Object.keys(latest?.sites || {}).length;
  $('subtitle').textContent = latest
    ? `${total} projects · synced ${fmtAgo(latest.syncedAt)}${demo ? ' · demo data' : ''}`
    : 'Not synced yet';

  if (!latest) {
    $('content').hidden = true;
    $('empty').hidden = false;
    $('empty').textContent = state.data.syncing ? 'First sync in progress…' : 'No data yet. Click "Sync now".';
    return;
  }
  $('empty').hidden = true;
  $('content').hidden = false;

  const model = buildModel();
  renderFilters(model);
  renderKpis(model);
  renderCharts(model);
  renderTable(model);
  renderRanks(model);
  renderNotes(model);
}

// ---------- data loading ----------

async function load() {
  const res = await fetch('/api/data');
  if (!res.ok) throw new Error(`/api/data returned HTTP ${res.status}`);
  state.data = await res.json();
  render();
  if (state.data.syncing) setTimeout(load, 3000);
}

// Deployed, a sync runs as a background job that outlives the request, so the
// answer comes back before the work is done. Watch for syncedAt to move
// instead. Locally the request already blocks until the sync finishes.
const SYNC_POLL_MS = 3000;
const SYNC_TIMEOUT_MS = 15 * 60 * 1000; // The platform's own ceiling for the job.

async function waitForSync(before) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SYNC_POLL_MS));
    await load();
    if (state.data.latest?.syncedAt !== before) return true;
  }
  return false;
}

$('sync').addEventListener('click', async () => {
  const button = $('sync');
  const before = state.data?.latest?.syncedAt;
  button.disabled = true;
  button.textContent = 'Syncing…';
  $('main').classList.add('busy');
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new Error(body.error || `HTTP ${res.status}`);
    if (body.async) {
      if (!(await waitForSync(before))) {
        alert('Sync is taking longer than expected. It may still finish — reload in a few minutes.');
      }
    } else {
      await load();
    }
  } catch (err) {
    alert(`Sync failed: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Sync now';
    $('main').classList.remove('busy');
  }
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.data && render());

async function start() {
  try {
    const res = await fetch('/api/config');
    applyConfig(res.ok ? await res.json() : {});
  } catch {
    applyConfig({});
  }
  try {
    await load();
  } catch (err) {
    $('content').hidden = true;
    $('empty').hidden = false;
    $('empty').textContent = `Could not load data: ${err.message}`;
    $('subtitle').textContent = '';
  }
}

start();

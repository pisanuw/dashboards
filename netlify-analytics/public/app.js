/* global Chart */

const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
  { days: Infinity, label: 'All' },
];
const WEEKLY_AFTER_DAYS = 92;
const RANK_ROWS = 10;

const $ = (id) => document.getElementById(id);
const state = {
  data: null,
  range: ((r) => (r === 'all' ? Infinity : r))(stored('range', 30)),
  hidden: new Set(stored('hidden', [])),
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
  const slots = ordered.length <= 8 ? 8 : 7;
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

  const perSite = visible.map((id) => ({
    id,
    ...history.sites[id],
    colorVar: colorVar[id],
    pageviews: metric(id, 'pageviews', start, today),
    visitors: metric(id, 'visitors', start, today),
    bandwidth: metric(id, 'bandwidth', start, today),
    latest: latest?.sites?.[id],
  })).sort((a, b) => b.pageviews - a.pageviews);

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

  // Stacked pageviews: one dataset per project; past 8 projects the tail folds into "Other".
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

function renderTable(model) {
  const max = Math.max(1, ...model.perSite.map((s) => s.pageviews));
  const total = Math.max(1, model.totals.pageviews);
  const head = el('thead', {}, el('tr', {},
    el('th', {}, 'Project'),
    el('th', { class: 'num' }, 'Pageviews'),
    el('th', { class: 'share' }, 'Share'),
    el('th', { class: 'num' }, 'Visitors'),
    el('th', { class: 'num' }, 'Bandwidth'),
    el('th', {}, 'Top page (30d)')));
  const rows = model.perSite.map((s) => el('tr', {},
    el('td', { class: 'name' },
      el('span', { class: 'swatch', style: { background: `var(${s.colorVar})` } }),
      s.url ? el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.name) : s.name),
    el('td', { class: 'num' }, fmtInt(s.pageviews)),
    el('td', { class: 'share', title: `${((s.pageviews / total) * 100).toFixed(1)}%` },
      el('div', { class: 'share-bar' },
        el('span', { style: { width: `${(s.pageviews / max) * 100}%`, background: `var(${s.colorVar})` } }))),
    el('td', { class: 'num' }, fmtInt(s.visitors)),
    el('td', { class: 'num' }, fmtBytes(s.bandwidth)),
    el('td', { class: 'top-page' }, s.latest?.pages?.[0]?.resource ?? ''),
  ));
  $('siteTable').replaceChildren(head, el('tbody', {}, rows));
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
  state.data = await res.json();
  render();
  if (state.data.syncing) setTimeout(load, 3000);
}

$('sync').addEventListener('click', async () => {
  const button = $('sync');
  button.disabled = true;
  button.textContent = 'Syncing…';
  $('main').classList.add('busy');
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error);
    await load();
  } catch (err) {
    alert(`Sync failed: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Sync now';
    $('main').classList.remove('busy');
  }
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.data && render());

load();

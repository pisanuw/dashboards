// Fake Netlify client for `npm run demo`. Returns the same response shapes as
// the real analytics API so the whole pipeline can be exercised offline.

import { HttpError } from './netlify.js';

const DAY = 86_400_000;

const SITES = [
  { id: 'demo-1', name: 'course-website', base: 900 },
  { id: 'demo-2', name: 'research-lab', base: 320 },
  { id: 'demo-3', name: 'personal-blog', base: 180 },
  { id: 'demo-4', name: 'cs-tutorials', base: 450 },
  { id: 'demo-5', name: 'conference-2026', base: 60 },
  { id: 'demo-6', name: 'old-portfolio', base: 0 },
];

const PAGES = ['/', '/about', '/schedule', '/assignments', '/blog/getting-started', '/docs/setup', '/contact', '/syllabus'];
const SOURCES = ['google.com', 'github.com', 'canvas.uw.edu', 'bing.com', 'linkedin.com', 'news.ycombinator.com', 'duckduckgo.com'];
const COUNTRIES = [
  ['US', 'United States'], ['IN', 'India'], ['CA', 'Canada'], ['GB', 'United Kingdom'],
  ['DE', 'Germany'], ['TR', 'Turkey'], ['AU', 'Australia'],
];

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function hash(str) {
  let h = 7;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 2147483647;
  return h;
}

function dailyCounts(site, from, to) {
  const out = [];
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  for (let t = start.getTime(); t <= to; t += DAY) {
    const r = rng(hash(site.id) + Math.floor(t / DAY))();
    const weekday = new Date(t).getDay();
    const weekly = weekday === 0 || weekday === 6 ? 0.6 : 1.1;
    out.push([t, Math.round(site.base * weekly * (0.7 + r * 0.6))]);
  }
  return out;
}

function ranking(site, items, total, limit) {
  const r = rng(hash(site.id + items[0]));
  let remaining = total;
  return items
    .map((item, i) => {
      const count = Math.round(remaining * (0.35 + r() * 0.2));
      remaining -= count;
      return { item, count, i };
    })
    .filter((x) => x.count > 0)
    .slice(0, limit);
}

export function createMockClient() {
  async function listSites() {
    return SITES.map((s) => ({
      id: s.id,
      name: s.name,
      url: `https://${s.name}.netlify.app`,
      adminUrl: `https://app.netlify.com/sites/${s.name}`,
    }));
  }

  async function analytics(siteId, endpoint, params) {
    const site = SITES.find((s) => s.id === siteId);
    if (!site.base) throw new HttpError(404, `mock/${siteId}/${endpoint}`, 'analytics not enabled');
    const from = Number(params.from);
    const to = Number(params.to);
    const limit = Number(params.limit || 10);
    const views = dailyCounts(site, from, to);
    const total = views.reduce((a, [, n]) => a + n, 0);

    switch (endpoint) {
      case 'pageviews':
        return views;
      case 'visitors':
        if (params.resolution === 'range') return [[from, Math.round(total * 0.3)]];
        return views.map(([t, n]) => [t, Math.round(n * 0.45)]);
      case 'bandwidth':
        return views.map(([t, n]) => ({ start: t, end: t + DAY, siteBandwidth: n * 180_000, accountBandwidth: 0 }));
      case 'ranking/pages':
        return ranking(site, PAGES, total, limit).map((x) => ({ resource: x.item, count: x.count }));
      case 'ranking/sources':
        return ranking(site, SOURCES, total * 0.4, limit).map((x) => ({ resource: x.item, count: x.count }));
      case 'ranking/countries':
        return ranking(site, COUNTRIES, total * 0.3, limit).map((x) => ({
          resource: x.item[0], country_name: x.item[1], count: x.count,
        }));
      case 'ranking/not_found':
        return ranking(site, ['/favicon.ico', '/wp-login.php', '/old-page', '/.env'], total * 0.02, limit)
          .map((x) => ({ resource: x.item, count: x.count }));
      default:
        throw new HttpError(404, endpoint);
    }
  }

  return { listSites, analytics };
}

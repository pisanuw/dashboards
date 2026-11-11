import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env file: rely on the real environment.
}

// Day boundaries are local-time, so the zone decides which day a pageview
// lands in. Unpinned, that is whatever zone the host happens to be in --
// which drifts when a laptop travels and is UTC on Netlify. Pinning TZ is what
// keeps a day meaning the same thing across machines. Set before any Date.
export const TIMEZONE = process.env.TZ || process.env.TIMEZONE || '';
if (TIMEZONE) process.env.TZ = TIMEZONE;

// The zone Date actually uses, pinned or not. Report this rather than TIMEZONE:
// an empty TZ does not mean UTC, it means "the host's own setting", and saying
// so is the difference between a visible choice and a silent one.
export const EFFECTIVE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const str = (name, fallback = '') => process.env[name]?.trim() || fallback;
const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
};
const list = (name) => str(name).split(',').map((s) => s.trim()).filter(Boolean);

// True when running inside a Netlify build or function.
//
// NETLIFY is set during builds but NOT in the functions runtime, so testing it
// alone makes a deployed function quietly fall back to the file store and read
// a disk that holds nothing. NETLIFY_BLOBS_CONTEXT is the runtime signal, and
// it is exactly the capability being detected.
export const ON_NETLIFY = Boolean(
  process.env.NETLIFY || process.env.NETLIFY_DEV || process.env.NETLIFY_BLOBS_CONTEXT,
);

export const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';

// --- storage -----------------------------------------------------------------

// Netlify has no writable disk that outlives a deploy, so default to Blobs there.
export const STORE_BACKEND = str('STORE', ON_NETLIFY && !DEMO ? 'blobs' : 'file');
export const BLOBS_STORE = str('BLOBS_STORE', 'netlify-analytics');
export const DATA_DIR = path.resolve(ROOT, str('DATA_DIR', DEMO ? 'data-demo' : 'data'));

// --- server ------------------------------------------------------------------

export const PORT = num('PORT', 3000);
export const HOST = str('HOST', '127.0.0.1');

// --- sync --------------------------------------------------------------------

export const SYNC_DAYS = num('SYNC_DAYS', 30);
// Re-sync on server start when the last sync is older than this many minutes.
export const STALE_MINUTES = num('STALE_MINUTES', 60);
// Sites fetched at once. Each site costs 8 analytics requests.
export const CONCURRENCY = num('CONCURRENCY', 4);
// The analytics service intermittently refuses a request with 401 (see
// src/netlify.js), so a refused request is retried rather than counted as a
// failure. It waits on the shared throttle pause below, not on a backoff of its
// own, and gives up on a time budget: while the service is refusing every
// caller, a request can see several refusals through no fault of its own, and
// counting those as its own strikes loses projects. ANALYTICS_RETRIES is only a
// backstop against a tight failure loop.
export const ANALYTICS_RETRIES = num('ANALYTICS_RETRIES', 20);
export const ANALYTICS_RETRY_BUDGET_MS = num('ANALYTICS_RETRY_BUDGET_MS', 90_000);
// When the whole run has spent this long, nothing is retried any more, so the
// sync still finishes and writes. A background function gets 15 minutes and
// stores nothing if it is killed, so stopping at 10 and recording some projects
// as errors beats being cut off with everything unwritten.
export const SYNC_RETRY_DEADLINE_MS = num('SYNC_RETRY_DEADLINE_MS', 600_000);
// How long every request pauses after the service refuses one, doubling per
// trip up to the maximum. A per-request backoff alone was not enough: four
// retries spanning ~7.5s all landed inside a pause the service was still
// enforcing, so the whole sync now waits together. The background function has
// 15 minutes and an unthrottled pass takes under a minute, so there is room to
// wait.
export const ANALYTICS_THROTTLE_PAUSE_MS = num('ANALYTICS_THROTTLE_PAUSE_MS', 2000);
export const ANALYTICS_THROTTLE_MAX_PAUSE_MS = num('ANALYTICS_THROTTLE_MAX_PAUSE_MS', 60_000);
// How many rows to keep per ranking (top pages, sources, countries, 404s).
export const RANKING_LIMIT = num('RANKING_LIMIT', 100);

// Which projects to sync. Empty include means "all". Patterns match the project
// name, case-insensitively, and may use * as a wildcard.
export const SITE_INCLUDE = list('SITE_INCLUDE');
export const SITE_EXCLUDE = list('SITE_EXCLUDE');

function toRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}
const matches = (patterns, name) => patterns.some((p) => toRegExp(p).test(name));

// Applied to the site list before any analytics request, so excluded projects
// cost nothing.
export function selectSites(sites) {
  return sites.filter((site) => {
    if (SITE_INCLUDE.length && !matches(SITE_INCLUDE, site.name)) return false;
    return !matches(SITE_EXCLUDE, site.name);
  });
}

// --- dashboard ---------------------------------------------------------------

// Served to the browser at /api/config so the page has no baked-in settings.
export const DASHBOARD = {
  title: str('DASHBOARD_TITLE', 'Netlify Analytics'),
  // Date-range buttons, as day counts. 0 means "all history".
  ranges: (list('DASHBOARD_RANGES').length ? list('DASHBOARD_RANGES') : ['7', '30', '90', '365', '0'])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0),
  defaultRange: num('DASHBOARD_DEFAULT_RANGE', 30),
  // Rows shown in each top-list card.
  rankRows: num('DASHBOARD_RANK_ROWS', 10),
  // Daily points are grouped into weeks beyond this span, to keep charts readable.
  weeklyAfterDays: num('DASHBOARD_WEEKLY_AFTER_DAYS', 92),
  // Shown in the dashboard footer, so a day that looks off can be traced.
  timezone: EFFECTIVE_TIMEZONE,
  timezonePinned: Boolean(TIMEZONE),
};

// --- credentials -------------------------------------------------------------

// NETLIFY_AUTH_TOKEN is the name the Netlify CLI uses; accept either.
export function getToken() {
  const token = str('NETLIFY_TOKEN') || str('NETLIFY_AUTH_TOKEN');
  if (!token) {
    throw new Error(
      'NETLIFY_TOKEN is not set. Copy .env.example to .env and add a personal access token,\n' +
      'or run `npm run demo` to try the dashboard with fake data.',
    );
  }
  return token;
}

// Shared secret the scheduled job presents when asking for a sync. Without one
// set, /api/sync is open to anyone who can already see the dashboard.
export const CRON_SECRET = str('CRON_SECRET');

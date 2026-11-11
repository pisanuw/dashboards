// Netlify clients. The sites endpoint is the official REST API; the analytics
// endpoints are the undocumented API behind the Netlify dashboard's Analytics
// tab, so they may change without notice.
//
// The analytics service sometimes refuses a request with 401 -- not 429 -- with
// no Retry-After and no rate-limit headers, and the same request then succeeds
// seconds later. Observed 2026-11-11: the nightly sync on Netlify recorded 28
// of 89 projects as having Analytics off while 88 of them had it on, and a
// laptop run of the sync's request pattern saw 108 of 704 requests refused
// across 15 projects, all in the last two seconds of the run.
//
// What triggers it is not established. It is not request volume: 1600 requests
// at concurrency 24 all succeeded, as did three full syncs (8 requests x 88
// projects) straight afterwards. The deployed function shares egress IPs with
// other Netlify customers, which would explain why the scheduled run is the one
// that keeps hitting it, but that is a guess and not a measurement.
//
// What is established is that such a 401 is transient and says nothing about
// the project. So it is retried here, and callers must establish whether a
// project has Analytics on from site.analyticsInstanceId rather than from an
// HTTP status.

import {
  ANALYTICS_RETRIES,
  ANALYTICS_RETRY_BUDGET_MS,
  ANALYTICS_THROTTLE_MAX_PAUSE_MS,
  ANALYTICS_THROTTLE_PAUSE_MS,
} from './config.js';

const API = 'https://api.netlify.com/api/v1';
const ANALYTICS = 'https://analytics.services.netlify.com/v2';
// Analytics is a per-site add-on: the site has it when a service instance of
// this slug exists, which is what `analytics_instance_id` on the site points at.
const ANALYTICS_SERVICE = 'analytics';

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.status = status;
  }
}

// Statuses worth retrying: 401 is the transient refusal above, 429 is the
// documented rate limit, 5xx is the service having a moment. A 404 is not here
// -- that is an endpoint or project that genuinely is not there, and retrying
// only delays the report. Note this makes a genuinely bad token cost every
// retry before it fails, which is the price of 401 being overloaded.
const RETRYABLE = new Set([401, 429, 500, 502, 503, 504]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The refusal is not per-request, it is the service telling this caller to stop
// for a while, so retrying one request while the others keep hammering just
// feeds it. The gate is shared: the first 401 pauses every in-flight worker
// until a common deadline, and repeated trips lengthen the pause. That is why
// a per-request backoff alone was not enough -- on 2026-11-11 the deployed sync
// still lost 25 of 88 projects with four retries spanning ~7.5s each, because
// all four landed inside one pause the service was still enforcing.
export function createThrottleGate({ baseMs = 2000, maxMs = 60_000, sleep = delay, now = () => Date.now() } = {}) {
  let pausedUntil = 0;
  let strikes = 0;
  const stats = { trips: 0, pausedMs: 0, longestPauseMs: 0 };

  return {
    stats,
    // Held by every request before it goes out, so a pause applies to all of them.
    async wait() {
      let staggered = false;
      for (;;) {
        const left = pausedUntil - now();
        if (left <= 0) {
          // Everything released by one deadline would otherwise arrive together
          // and trip the limiter again, so each caller waits a little longer by
          // its own random amount. Only once per request, or a busy gate would
          // keep pushing the same caller back.
          if (staggered || !stats.trips) return;
          staggered = true;
          await sleep(Math.random() * baseMs);
          continue;
        }
        stats.pausedMs += left;
        await sleep(left);
      }
    },
    // Each trip doubles the pause, jittered so the workers do not resume in
    // lockstep and trip it again together.
    trip() {
      strikes++;
      stats.trips++;
      const penalty = Math.min(maxMs, baseMs * 2 ** (strikes - 1));
      const until = now() + penalty + Math.random() * penalty;
      if (until > pausedUntil) {
        pausedUntil = until;
        stats.longestPauseMs = Math.max(stats.longestPauseMs, pausedUntil - now());
      }
      return pausedUntil;
    },
    // A success means the pressure has eased, so the next pause starts shorter.
    ok() {
      if (strikes) strikes--;
    },
  };
}

export function createNetlifyClient(token, {
  retries = ANALYTICS_RETRIES,
  retryBudgetMs = ANALYTICS_RETRY_BUDGET_MS,
  throttlePauseMs = ANALYTICS_THROTTLE_PAUSE_MS,
  throttleMaxPauseMs = ANALYTICS_THROTTLE_MAX_PAUSE_MS,
  sleep = delay,
  gate = createThrottleGate({ baseMs: throttlePauseMs, maxMs: throttleMaxPauseMs, sleep }),
  // Absolute time after which nothing is retried, so a throttled run still
  // finishes and writes what it managed to read. Without it a long enough
  // throttle runs the function out of its 15 minutes and nothing is stored at
  // all, which is worse than a run that reports some projects as errors.
  runDeadline = null,
} = {}) {
  // Reported by the sync so a throttled run shows up as throttling rather than
  // as projects that quietly went missing.
  const stats = { retries: 0, retriedRequests: 0, throttle: gate.stats };

  async function send(method, url, body) {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''));
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const get = (url) => send('GET', url);

  async function listSites() {
    const sites = [];
    for (let page = 1; ; page++) {
      const batch = await get(`${API}/sites?filter=all&per_page=100&page=${page}`);
      sites.push(...batch);
      if (batch.length < 100) break;
    }
    return sites.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.ssl_url || s.url,
      adminUrl: s.admin_url,
      // null when Analytics is not enabled for the site.
      analyticsInstanceId: s.analytics_instance_id || null,
    }));
  }

  // Turns Analytics on for a site. Returns the new service instance.
  async function enableAnalytics(siteId) {
    return send('POST', `${API}/sites/${siteId}/services/${ANALYTICS_SERVICE}/instances`, {});
  }

  // Turns Analytics off by removing the site's service instance.
  async function disableAnalytics(siteId, instanceId) {
    return send('DELETE', `${API}/sites/${siteId}/services/${ANALYTICS_SERVICE}/instances/${instanceId}`);
  }

  // Returns the `data` field of an analytics response, retrying a throttled or
  // flaky request with exponential backoff. The backoff is fully jittered
  // because the sync runs several of these at once and an unjittered retry
  // would send the whole batch back at the same instant.
  async function analytics(siteId, endpoint, params) {
    const qs = new URLSearchParams(params);
    const url = `${ANALYTICS}/${siteId}/${endpoint}?${qs}`;
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      await gate.wait();
      try {
        const body = await get(url);
        gate.ok();
        return body.data;
      } catch (err) {
        if (!(err instanceof HttpError) || !RETRYABLE.has(err.status)) throw err;
        // Give up on time, not on a count of attempts. While the service is
        // refusing everyone, a request can see several refusals in a row through
        // no fault of its own, and counting those cost 3 of 88 projects in the
        // simulation even with the shared pause. What matters is how long we are
        // willing to wait, so that is what is budgeted; `retries` stays only as
        // a backstop against a tight failure loop.
        const spent = Date.now() - started;
        const outOfTime = spent >= retryBudgetMs || (runDeadline && Date.now() >= runDeadline);
        if (outOfTime || attempt >= retries) throw err;
        if (attempt === 0) stats.retriedRequests++;
        stats.retries++;
        gate.trip();
      }
    }
  }

  return { listSites, analytics, enableAnalytics, disableAnalytics, stats };
}

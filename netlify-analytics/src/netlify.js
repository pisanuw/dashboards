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

import { ANALYTICS_RETRIES, ANALYTICS_RETRY_BASE_MS } from './config.js';

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

export function createNetlifyClient(token, {
  retries = ANALYTICS_RETRIES,
  retryBaseMs = ANALYTICS_RETRY_BASE_MS,
  sleep = delay,
} = {}) {
  // Reported by the sync so a throttled run shows up as throttling in the log
  // rather than as projects that quietly went missing.
  const stats = { retries: 0, retriedRequests: 0 };

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
    for (let attempt = 0; ; attempt++) {
      try {
        const body = await get(url);
        return body.data;
      } catch (err) {
        if (attempt >= retries || !(err instanceof HttpError) || !RETRYABLE.has(err.status)) throw err;
        if (attempt === 0) stats.retriedRequests++;
        stats.retries++;
        await sleep(Math.round(Math.random() * retryBaseMs * 2 ** attempt));
      }
    }
  }

  return { listSites, analytics, enableAnalytics, disableAnalytics, stats };
}

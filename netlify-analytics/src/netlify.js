// Netlify clients. The sites endpoint is the official REST API; the analytics
// endpoints are the undocumented API behind the Netlify dashboard's Analytics
// tab, so they may change without notice.

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

export function createNetlifyClient(token) {
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

  // Returns the `data` field of an analytics response.
  async function analytics(siteId, endpoint, params) {
    const qs = new URLSearchParams(params);
    const body = await get(`${ANALYTICS}/${siteId}/${endpoint}?${qs}`);
    return body.data;
  }

  return { listSites, analytics, enableAnalytics, disableAnalytics };
}

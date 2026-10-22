// Netlify clients. The sites endpoint is the official REST API; the analytics
// endpoints are the undocumented API behind the Netlify dashboard's Analytics
// tab, so they may change without notice.

const API = 'https://api.netlify.com/api/v1';
const ANALYTICS = 'https://analytics.services.netlify.com/v2';

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.status = status;
  }
}

export function createNetlifyClient(token) {
  async function get(url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''));
    return res.json();
  }

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
    }));
  }

  // Returns the `data` field of an analytics response.
  async function analytics(siteId, endpoint, params) {
    const qs = new URLSearchParams(params);
    const body = await get(`${ANALYTICS}/${siteId}/${endpoint}?${qs}`);
    return body.data;
  }

  return { listSites, analytics };
}

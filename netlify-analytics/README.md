# Netlify Analytics (all projects)

A local dashboard that combines Netlify Web Analytics across all of your Netlify projects:
total pageviews, visitors and bandwidth, a per-project breakdown, and merged top pages,
sources, countries and 404s.

Netlify only keeps 30 days of analytics. Each sync saves daily numbers to `data/history.json`,
so if you sync regularly the dashboard builds up history beyond 30 days (90d / 1y / All).

## Setup

Requires Node 20.12+.

```sh
npm install
cp .env.example .env    # then paste your token into .env
npm run check           # verifies the token works with the sites and analytics APIs
npm start               # http://localhost:3000
```

Create the token in Netlify under **User settings > Applications > Personal access tokens**.
It has full access to your account, so keep `.env` private (it is gitignored).

`npm start` syncs automatically when the last sync is more than an hour old; the
**Sync now** button forces one. `npm run demo` runs the dashboard with fake data
(stored separately in `data-demo/`).

## Keeping history

Run a sync once a day so no day falls outside Netlify's 30-day window. With cron
(`crontab -e`), adjusting the paths:

```
15 8 * * * cd /path/to/dashboards/netlify-analytics && /usr/local/bin/node src/sync.js >> data/sync.log 2>&1
```

On macOS, cron needs Full Disk Access if the repo is under `~/Documents` or `~/Desktop`;
a launchd agent is the alternative.

## Notes and caveats

- Only the project list uses Netlify's official API. The analytics numbers come from the
  **undocumented** API behind the Analytics tab in the Netlify UI
  (`analytics.services.netlify.com/v2/<site_id>/...`). Netlify does not support it and it
  may change; `npm run check` is the quickest way to see whether it still works.
- Projects without Analytics enabled are listed at the bottom of the dashboard and skipped.
- "Visitors" is the sum of each project's daily unique visitors, so one person visiting two
  projects (or on two days) counts twice.
- Top lists (pages, sources, countries, 404s) always reflect the last 30 days as of the
  latest sync; the date range filter applies to the charts, totals and project table.

## Files

| Path | Purpose |
| --- | --- |
| `src/netlify.js` | API client (sites + analytics) |
| `src/sync.js` | Fetches every project, merges into `data/` (`npm run sync`) |
| `src/server.js` | Local server: dashboard + `/api/data` + `/api/sync` |
| `src/check.js` | Token / API sanity check |
| `src/mock.js` | Fake data for `npm run demo` |
| `public/` | Dashboard (Chart.js, no build step) |

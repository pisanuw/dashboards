# Netlify Analytics (all projects)

A dashboard that combines Netlify Web Analytics across all of your Netlify projects:
total pageviews, visitors and bandwidth, a per-project breakdown, and merged top pages,
sources, countries and 404s.

Netlify only keeps 30 days of analytics. Each sync saves daily numbers to the store,
so if you sync regularly the dashboard builds up history beyond 30 days (90d / 1y / All).

It runs two ways from the same code: on your laptop against JSON files, or deployed to
Netlify against Netlify Blobs. See [Deploying](#deploying).

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

## Deploying

```sh
netlify sites:create --name <site-name>   # or `netlify link` to an existing one
netlify env:set NETLIFY_TOKEN      "<personal access token>"
netlify env:set TZ                 "America/Los_Angeles"
netlify env:set DASHBOARD_PASSWORD "<something long>"
netlify env:set CRON_SECRET        "$(openssl rand -hex 32)"
netlify deploy --build --prod
npm run seed -- --site-id=<site id>        # copy existing history up (once)
```

What the deploy consists of:

| Piece | Why |
| --- | --- |
| `public/` as a static site | the dashboard has no build step beyond copying Chart.js in |
| `netlify/functions/data`, `config` | `/api/data` and `/api/config` |
| `netlify/functions/sync` | the **Sync now** button; answers `202` and hands off |
| `netlify/functions/sync-background` | the real sync (a background function gets 15 min) |
| `netlify/functions/scheduled-sync` | the daily cron, which only triggers the above |
| `netlify/edge-functions/auth` | HTTP Basic auth in front of everything |
| Netlify Blobs | the store, because no disk survives a deploy |

A full pass over ~75 projects takes around 40 seconds, which is why the work is split:
a scheduled function is capped at 30 seconds, and a background function at 15 minutes.
The schedule only fires the trigger.

### Access

A Netlify site is public by default and this one reports traffic for every project in
the account, so set `DASHBOARD_PASSWORD`. The edge function then asks for HTTP Basic
auth on every path, including the API and the default `/.netlify/functions/*` URLs.
Leaving it unset leaves the site open.

On paid Netlify plans, the built-in site password protection is an alternative; the
edge function works on any plan and needs no dashboard configuration.

`CRON_SECRET` protects the one path the password gate has to let through: the
background sync, which the scheduler calls with no browser and no password.

### Moving history in and out

```sh
npm run seed -- --site-id=<id>              # data/ -> Blobs
npm run seed -- --site-id=<id> --pull       # Blobs -> data/   (backup, or undo a deploy)
npm run seed -- --site-id=<id> --dry-run    # report, change nothing
```

It refuses to overwrite a history that has more days than the one replacing it unless
you add `--force`, since that is almost always a mistake.

## Configuration

Everything is environment variables, listed in `.env.example`. Locally they come from
`.env`; on Netlify set them with `netlify env:set` (values in `netlify.toml` are
build-scope only and never reach the functions).

| Variable | Default | What it does |
| --- | --- | --- |
| `NETLIFY_TOKEN` | — | personal access token (`NETLIFY_AUTH_TOKEN` also accepted) |
| `TZ` | host setting | the zone day boundaries follow — see below |
| `DASHBOARD_PASSWORD` | unset (open) | HTTP Basic password for the deployed site |
| `DASHBOARD_USER` | `admin` | the matching username |
| `CRON_SECRET` | unset | shared secret guarding the background sync |
| `STORE` | `file`, `blobs` on Netlify | where the two documents live |
| `BLOBS_STORE` | `netlify-analytics` | blob store name |
| `DATA_DIR` | `data` | directory for the `file` store |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | local server |
| `SYNC_DAYS` | `30` | days requested per sync (Netlify serves at most 30) |
| `STALE_MINUTES` | `60` | re-sync on start when the last one is older than this |
| `CONCURRENCY` | `4` | projects fetched at once; each costs 8 requests |
| `RANKING_LIMIT` | `100` | rows kept per ranking |
| `SITE_INCLUDE` / `SITE_EXCLUDE` | unset / unset | which projects to sync |
| `DASHBOARD_TITLE` | `Netlify Analytics` | page heading |
| `DASHBOARD_RANGES` | `7,30,90,365,0` | date-range buttons, in days; `0` is "all" |
| `DASHBOARD_DEFAULT_RANGE` | `30` | which one is selected first |
| `DASHBOARD_RANK_ROWS` | `10` | rows per top-list card |
| `DASHBOARD_WEEKLY_AFTER_DAYS` | `92` | span past which daily points group into weeks |

`SITE_INCLUDE` and `SITE_EXCLUDE` are comma-separated name patterns, case-insensitive,
with `*` as a wildcard. An empty `SITE_INCLUDE` means every project; `SITE_EXCLUDE`
wins over `SITE_INCLUDE`. Filtering happens before any analytics request, so excluded
projects cost nothing.

```sh
SITE_EXCLUDE='test-*,*-scratch' npm run sync
```

### Time zones

A "day" is a local-time day, and the zone decides which day a pageview lands in. Left
alone, that is whatever zone the machine is in — which changes when a laptop travels,
and is UTC on Netlify. Pin `TZ` so a day keeps meaning the same thing:

```sh
netlify env:set TZ America/Los_Angeles
```

The dashboard footer names the zone in use, and says so when your browser is in a
different one. Days recorded before `TZ` was pinned keep whatever boundaries they were
collected with.

## Keeping history

Deployed, `netlify/functions/scheduled-sync` runs daily; change the cadence in
`netlify.toml` under `[functions."scheduled-sync"]`.

Locally, run a sync once a day so no day falls outside Netlify's 30-day window. With
cron (`crontab -e`), adjusting the paths:

```
15 8 * * * cd /path/to/dashboards/netlify-analytics && /usr/local/bin/node src/sync.js >> data/sync.log 2>&1
```

On macOS, cron needs Full Disk Access if the repo is under `~/Documents` or `~/Desktop`;
a launchd agent is the alternative. Running both the local cron and the deployed
schedule is harmless but pointless — they write to different stores.

## The Projects table

One row per project, one column per analytics feature, sortable by any column (click a
header, click again to reverse). Numbers sort high-to-low first, text A-Z first, and
projects with nothing in a column stay at the bottom either way.

| Column | Follows the date range? |
| --- | --- |
| Project | n/a |
| Pageviews, Share, Visitors, Views/visitor, Bandwidth | yes |
| Top page, Top source, Top country, 404s | no, always the last 30 days (badged `30d`) |

The chosen sort is remembered across reloads, alongside the date range and which projects
are hidden.

## Turning Analytics on and off

`npm run analytics -- status` lists every project and whether Analytics is on,
read straight from the Netlify API (more reliable than inferring it from a failed sync):

```sh
npm run analytics -- status                     # all projects
npm run analytics -- status pull-the-pin-lab    # one project
npm run analytics -- disable <project>...       # one or more projects
npm run analytics -- disable --all --yes        # every project
```

Add `--dry-run` to any of these to see what would change without changing it.
`<project>` is a project name or a site id.

**Enabling has to be done in the Netlify UI.** Netlify refuses to provision the
Analytics add-on over its API (`HTTP 422 Provisioning this addon via API is not
supported`), and the CLI and MCP server go through the same endpoint, so there is no
scripted route. `npm run analytics -- enable <project>` therefore does not enable
anything: it prints the page to open for each project
(`https://app.netlify.com/projects/<project>/analytics`) and exits non-zero.

Disabling works the other way round: the API will delete the add-on, but re-enabling
is a UI trip, so the command says so before it acts.

## Notes and caveats

- Only the project list uses Netlify's official API. The analytics numbers come from the
  **undocumented** API behind the Analytics tab in the Netlify UI
  (`analytics.services.netlify.com/v2/<site_id>/...`). Netlify does not support it and it
  may change; `npm run check` is the quickest way to see whether it still works.
- Projects without Analytics enabled are listed at the bottom of the dashboard and skipped.
- "Visitors" is the sum of each project's daily unique visitors, so one person visiting two
  projects (or on two days) counts twice.
- Rankings (pages, sources, countries, 404s) always reflect the last 30 days as of the
  latest sync, because that is all Netlify serves. The date range filter applies to the
  charts, the totals and the daily metrics in the Projects table; the four ranking columns
  in that table are badged `30d` and do not follow it.

## Files

| Path | Purpose |
| --- | --- |
| `src/config.js` | Every setting, read from the environment |
| `src/store.js` | Where the data lives: JSON files or Netlify Blobs |
| `src/api.js` | The API itself, independent of how it is served |
| `src/netlify.js` | API client (sites + analytics) |
| `src/sync.js` | Fetches every project and merges into the store (`npm run sync`) |
| `src/server.js` | Local server: dashboard + `/api/*` |
| `src/check.js` | Token / API sanity check |
| `src/analytics.js` | Reports / changes which projects have Analytics on |
| `src/mock.js` | Fake data for `npm run demo` |
| `scripts/build.mjs` | Copies Chart.js into `public/vendor/` for the static deploy |
| `scripts/seed.mjs` | Moves history between `data/` and Blobs |
| `netlify/functions/` | The deployed API and the scheduled sync |
| `netlify/edge-functions/auth.js` | Basic auth in front of the site |
| `public/` | Dashboard (Chart.js, no build step) |

# CHANGES

2026-11-02 [scope] netlify-analytics gains a deployed mode: same code runs locally on JSON files or on Netlify against Blobs.
2026-11-02 [decision] Deploy target is Netlify, not Render: Render's free tier has no durable disk and no reliable cron, Netlify Blobs plus scheduled/background functions covers both.
2026-11-02 [decision] A full sync takes ~40s, over Netlify's 30s scheduled-function cap, so the schedule only triggers a background function (15 min budget).
2026-11-02 [code] src/store.js abstracts storage (file | blobs); src/api.js holds the API so the local server and the functions cannot drift.
2026-11-02 [decision] All settings move to environment variables (see .env.example): site filtering, dashboard ranges/title/rank rows, concurrency, ranking limit.
2026-11-02 [note] Day buckets follow local time and had been following the laptop's zone (Europe/Berlin while travelling). TZ now pinned to America/Los_Angeles; days recorded earlier keep the boundaries they were collected with.
2026-11-02 [decision] Deployed site is gated by HTTP Basic auth in an edge function (DASHBOARD_PASSWORD), since the repo is public and the dashboard covers every project in the account.

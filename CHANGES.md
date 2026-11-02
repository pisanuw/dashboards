# CHANGES

2026-11-02 [scope] netlify-analytics gains a deployed mode: same code runs locally on JSON files or on Netlify against Blobs.
2026-11-02 [decision] Deploy target is Netlify, not Render: Render's free tier has no durable disk and no reliable cron, Netlify Blobs plus scheduled/background functions covers both.
2026-11-02 [decision] A full sync takes ~40s, over Netlify's 30s scheduled-function cap, so the schedule only triggers a background function (15 min budget).
2026-11-02 [code] src/store.js abstracts storage (file | blobs); src/api.js holds the API so the local server and the functions cannot drift.
2026-11-02 [decision] All settings move to environment variables (see .env.example): site filtering, dashboard ranges/title/rank rows, concurrency, ranking limit.
2026-11-02 [note] Day buckets follow local time and had been following the laptop's zone (Europe/Berlin while travelling). TZ now pinned to America/Los_Angeles; days recorded earlier keep the boundaries they were collected with.
2026-11-02 [decision] Deployed site is gated by HTTP Basic auth in an edge function (DASHBOARD_PASSWORD), since the repo is public and the dashboard covers every project in the account.
2026-11-02 [code] Deployed to Netlify as pisan-analytics (https://pisan-analytics.netlify.app), gated by Basic auth; 41 days of existing history seeded into Blobs.
2026-11-02 [note] Storage auto-detection first keyed on process.env.NETLIFY, which Netlify sets during builds but not in the functions runtime: the deployed site silently used the file store and showed an empty dashboard while the data sat in Blobs. Now keyed on NETLIFY_BLOBS_CONTEXT, and STORE=blobs is set explicitly on the site.
2026-11-02 [note] A background function's 202 is the platform acknowledging the invocation, before any code runs, so CRON_SECRET stops the work but not the invocation; verified over 90s that an unauthorized call writes nothing.
2026-11-02 [decision] Sync schedule is 15 8 * * * (UTC), just past LA midnight so each run sees a complete day, declared only in netlify/functions/scheduled-sync.mjs because a function's own config overrides netlify.toml.
2026-11-02 [code] Added /api/health reporting the store backend, keys and zone the deployed function actually sees.

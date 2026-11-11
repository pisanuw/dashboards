// Writes everything the dashboard shows to a JSON file.
//
//   npm run export                     all history   -> data/exports/
//   npm run export -- --range=30       the last 30 days
//   npm run export -- --out=/tmp/x     somewhere else
//   npm run export -- --stdout         to stdout, for piping
//
// The numbers come from public/stats.js, the same module the page itself
// renders from, so an export and the screen cannot disagree. The dashboard's
// Download button produces the same document from the browser.
//
// The default output directory is inside DATA_DIR, which is gitignored: these
// files are traffic data for every project in the account, and this repo is
// public.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARD, DATA_DIR, DEMO } from './config.js';
import { createStore } from './store.js';
import { readDashboardData } from './api.js';
import { buildExport, keyOf, rangeLabel, toDays } from '../public/stats.js';

// One export document, built from whatever the store holds.
export async function exportStatistics({ store, range = Infinity } = {}) {
  const target = store ?? (await createStore());
  const data = await readDashboardData(target);
  return buildExport(data, {
    range,
    timezone: DASHBOARD.timezone,
    timezonePinned: DASHBOARD.timezonePinned,
  });
}

// netlify-analytics-30d-2026-11-02.json
export function exportFilename(doc, prefix = 'netlify-analytics') {
  return `${prefix}-${doc.range.label.toLowerCase()}-${keyOf(new Date(doc.generatedAt))}.json`;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const value = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : '';
  };

  const raw = value('range') || 'all';
  if (raw !== 'all' && !Number.isFinite(Number(raw))) {
    console.error(`--range must be a number of days or "all", got "${raw}"`);
    process.exit(1);
  }
  const range = raw === 'all' ? Infinity : toDays(raw);

  const store = await createStore();
  const doc = await exportStatistics({ store, range });
  const text = JSON.stringify(doc, null, flag('compact') ? 0 : 2);

  if (flag('stdout')) {
    // `npm run export -- --stdout | head` closes the pipe early; that is the
    // caller being done, not an error worth a stack trace.
    process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });
    process.stdout.write(`${text}\n`);
    return;
  }

  const dir = path.resolve(value('out') || path.join(DATA_DIR, 'exports'));
  const file = path.join(dir, exportFilename(doc, DEMO ? 'netlify-analytics-demo' : 'netlify-analytics'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, text);

  if (!doc.source.syncedAt) {
    console.log('Nothing synced yet, so the export is empty. Run `npm run sync` first.');
  }
  console.log(`Range:    ${rangeLabel(range)}  (${doc.range.start} to ${doc.range.end}, ${doc.range.days} days)`);
  console.log(`Projects: ${doc.totals.projectsIncluded}, ${doc.totals.projectsWithTraffic} with traffic`);
  console.log(`Totals:   ${doc.totals.pageviews.toLocaleString()} pageviews, ${doc.totals.visitors.toLocaleString()} visitors`);
  console.log(`Written:  ${file}  (${text.length.toLocaleString()} bytes)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

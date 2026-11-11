// Moves the two dashboard documents between the local data/ directory and the
// deployed site's Netlify Blobs store.
//
//   npm run seed                     push data/*.json  ->  Blobs
//   npm run seed -- --pull           Blobs  ->  data/*.json   (backup / undo)
//   npm run seed -- --merge          combine both sides, keep everything
//   npm run seed -- --dry-run        report, change nothing
//   npm run seed -- --force          copy even though it would lose data
//
// Netlify only keeps 30 days of analytics, so the store on each side is the
// only lasting record of anything older. Both sides accumulate independently --
// a local `npm run sync` and the deployed nightly one write to different
// stores -- so by the time you run this, each side usually holds days the other
// does not. A plain copy in either direction throws away whatever the target
// had and the source lacks, which is why it is checked for first and why
// --merge exists.
//
// Needs NETLIFY_SITE_ID (or --site-id) and a token, because outside a function
// the Blobs client has no site context of its own.

import { getStore } from '@netlify/blobs';
import { BLOBS_STORE, DATA_DIR, getToken } from '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const NAMES = ['history', 'latest'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

const pull = flag('pull');
const dryRun = flag('dry-run');
const merge = flag('merge');
const force = flag('force');
const siteID = value('site-id') || process.env.NETLIFY_SITE_ID || process.env.SITE_ID;

if (!siteID) {
  console.error('No site id. Pass --site-id=<id>, or set NETLIFY_SITE_ID in .env.');
  console.error('Find it with: netlify status   (or the site settings page)');
  process.exit(1);
}

const store = getStore({ name: BLOBS_STORE, siteID, token: getToken(), consistency: 'strong' });
const fileFor = (name) => path.join(DATA_DIR, `${name}.json`);
const describe = (v) => (v == null ? 'empty' : `${JSON.stringify(v).length.toLocaleString()} bytes`);

async function readLocal(name) {
  try {
    return JSON.parse(await fs.readFile(fileFor(name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeLocal(name, value) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const file = fileFor(name);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file);
}

const dayCount = (history) =>
  new Set(Object.values(history?.daily || {}).flatMap((d) => Object.keys(d))).size;

// Every (project, day) that the store holds a row for. This is the unit that
// can actually be lost, and the reason this is not a count of distinct dates:
// a date count cannot see a per-project hole. On 2026-11-11 both stores spanned
// the same 50 dates while the deployed one was missing 131 project-days of
// traffic, so a date-count guard compared 50 against 50 and waved the copy
// through.
function cells(history) {
  const out = new Set();
  for (const [id, days] of Object.entries(history?.daily || {})) {
    for (const date of Object.keys(days || {})) out.add(`${id}\u0000${date}`);
  }
  return out;
}

const hasTraffic = (history, cell) => {
  const [id, date] = cell.split('\u0000');
  const row = history?.daily?.[id]?.[date] || {};
  return (row.pageviews || 0) + (row.visitors || 0) + (row.bandwidth || 0) > 0;
};

const nameOf = (history, id) => history?.sites?.[id]?.name || id;

// Union of both sides. Overlapping (project, day) rows take the source's value,
// which is the direction the caller asked for and matches how a sync merges its
// own fetch over what it already had. Nothing is dropped either way.
function mergeHistory(source, target) {
  const merged = {
    sites: { ...target?.sites, ...source?.sites },
    daily: {},
  };
  for (const id of new Set([...Object.keys(target?.daily || {}), ...Object.keys(source?.daily || {})])) {
    merged.daily[id] = { ...(target?.daily?.[id] || {}), ...(source?.daily?.[id] || {}) };
  }
  return merged;
}

// Reports what a copy would discard, so the decision is never taken blind.
function lossReport(source, target) {
  const have = cells(source);
  const lost = [...cells(target)].filter((c) => !have.has(c));
  const withTraffic = lost.filter((c) => hasTraffic(target, c));
  const projectsGone = Object.keys(target?.daily || {})
    .filter((id) => !(id in (source?.daily || {})))
    .map((id) => nameOf(target, id));
  const byProject = new Map();
  for (const c of withTraffic) {
    const [id, date] = c.split('\u0000');
    if (!byProject.has(id)) byProject.set(id, []);
    byProject.get(id).push(date);
  }
  return { lost, withTraffic, projectsGone, byProject };
}

console.log(`Store "${BLOBS_STORE}" on site ${siteID}`);
console.log(`Direction: ${pull ? 'Blobs -> data/' : 'data/ -> Blobs'}${merge ? '  (merge)' : ''}${dryRun ? '  (dry run)' : ''}\n`);

for (const name of NAMES) {
  const local = await readLocal(name);
  const remote = await store.get(name, { type: 'json' });
  const [source, target] = pull ? [remote, local] : [local, remote];

  console.log(`${name}`);
  const detail = (v) => (name === 'history' && v ? `, ${dayCount(v)} days, ${cells(v).size.toLocaleString()} project-days` : '');
  console.log(`  local   ${describe(local)}${detail(local)}`);
  console.log(`  remote  ${describe(remote)}${detail(remote)}`);

  if (source == null) {
    console.log('  skipped: nothing to copy from\n');
    continue;
  }

  let payload = source;

  if (name === 'history' && target) {
    const { lost, withTraffic, projectsGone, byProject } = lossReport(source, target);

    if (lost.length) {
      // Say what is on each side before anything is decided.
      console.log(`  the target holds ${lost.length.toLocaleString()} project-day(s) the source does not` +
        `${withTraffic.length ? `, ${withTraffic.length.toLocaleString()} of them carrying traffic` : ', none carrying traffic'}:`);
      for (const [id, dates] of [...byProject].slice(0, 10)) {
        console.log(`    ${nameOf(target, id).padEnd(32)} ${dates.sort().slice(0, 8).join(',')}${dates.length > 8 ? ` +${dates.length - 8}` : ''}`);
      }
      if (byProject.size > 10) console.log(`    ...and ${byProject.size - 10} more project(s)`);
      if (projectsGone.length) console.log(`    projects only in the target: ${projectsGone.join(', ')}`);
    }

    if (merge) {
      payload = mergeHistory(source, target);
      const gained = cells(payload).size - cells(target).size;
      console.log(`  merged: ${cells(payload).size.toLocaleString()} project-days, ` +
        `${gained >= 0 ? '+' : ''}${gained.toLocaleString()} against the target, nothing dropped`);
    } else if (lost.length && !force) {
      console.log('  REFUSED: copying would discard the rows listed above.');
      console.log('  Use --merge to keep both sides, or --force to copy anyway.\n');
      process.exitCode = 1;
      continue;
    } else if (lost.length) {
      console.log('  --force given: copying anyway, the rows above will be gone.');
    }
  }

  // `latest` is a snapshot of one sync's rankings, so there is nothing to merge:
  // the only sensible choice between two of them is the newer one.
  if (name === 'latest' && target?.syncedAt && source?.syncedAt && source.syncedAt < target.syncedAt) {
    console.log(`  the target's snapshot is newer (${target.syncedAt} vs ${source.syncedAt})`);
    if (merge) {
      console.log('  merge: keeping the target’s newer snapshot\n');
      continue;
    }
    if (!force) {
      console.log('  REFUSED: copying would replace it with an older one.');
      console.log('  Use --merge to keep the newer, or --force to copy anyway.\n');
      process.exitCode = 1;
      continue;
    }
    console.log('  --force given: replacing it with the older snapshot.');
  }

  if (dryRun) {
    console.log('  would copy\n');
    continue;
  }
  if (pull) await writeLocal(name, payload);
  else await store.setJSON(name, payload);
  console.log('  copied\n');
}

console.log(dryRun ? 'Dry run: nothing changed.' : 'Done.');

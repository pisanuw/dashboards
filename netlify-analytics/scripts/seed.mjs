// Moves the two dashboard documents between the local data/ directory and the
// deployed site's Netlify Blobs store.
//
//   npm run seed             push data/*.json  ->  Blobs   (first deploy)
//   npm run seed -- --pull   Blobs  ->  data/*.json        (backup / undo)
//   npm run seed -- --dry-run          report, change nothing
//
// Netlify only keeps 30 days of analytics, so pushing the history you already
// have is the difference between a dashboard that starts at 30 days and one
// that keeps everything collected so far. Run it once, after the first deploy.
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

console.log(`Store "${BLOBS_STORE}" on site ${siteID}`);
console.log(`Direction: ${pull ? 'Blobs -> data/' : 'data/ -> Blobs'}${dryRun ? '  (dry run)' : ''}\n`);

for (const name of NAMES) {
  const local = await readLocal(name);
  const remote = await store.get(name, { type: 'json' });
  const [source, target] = pull ? [remote, local] : [local, remote];

  console.log(`${name}`);
  console.log(`  local   ${describe(local)}${name === 'history' && local ? `, ${dayCount(local)} days` : ''}`);
  console.log(`  remote  ${describe(remote)}${name === 'history' && remote ? `, ${dayCount(remote)} days` : ''}`);

  if (source == null) {
    console.log('  skipped: nothing to copy from\n');
    continue;
  }
  // Overwriting accumulated history with less of it is almost always a mistake,
  // so say so and let --force decide.
  if (name === 'history' && target && dayCount(target) > dayCount(source) && !flag('force')) {
    console.log(`  REFUSED: the target has ${dayCount(target)} days, more than the ${dayCount(source)} being copied.`);
    console.log('  Re-run with --force if you really mean to replace it.\n');
    process.exitCode = 1;
    continue;
  }
  if (dryRun) {
    console.log('  would copy\n');
    continue;
  }
  if (pull) await writeLocal(name, source);
  else await store.setJSON(name, source);
  console.log('  copied\n');
}

console.log(dryRun ? 'Dry run: nothing changed.' : 'Done.');

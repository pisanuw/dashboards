// Reports and changes which projects have Netlify Web Analytics turned on.
//
//   node src/analytics.js status [<project>...]
//   node src/analytics.js enable  <project>...
//   node src/analytics.js disable <project>... | --all --yes
//
// <project> is a project name or a site id. --all covers every project in the
// account and needs --yes as well. --dry-run prints what would change without
// calling the write endpoints.
//
// Caveat: Netlify refuses to provision the Analytics add-on over the API
// (HTTP 422 "Provisioning this addon via API is not supported"), so `enable`
// cannot do the work -- it reports the UI link to click for each project
// instead. `disable` deletes the add-on's service instance, which the API does
// allow, but re-enabling is then a UI trip.

import { fileURLToPath } from 'node:url';
import { getToken } from './config.js';
import { createNetlifyClient } from './netlify.js';

// Netlify's answer when you ask it to provision the add-on over the API.
const API_PROVISIONING_BLOCKED = /provisioning this addon via api is not supported/i;

const USAGE = `Usage:
  node src/analytics.js status  [<project>...]
  node src/analytics.js enable  <project>... | --all --yes
  node src/analytics.js disable <project>... | --all --yes

Options:
  --all        apply to every project in the account (requires --yes)
  --yes        confirm a bulk change
  --dry-run    report what would change, change nothing

<project> may be a project name or a site id.

Netlify blocks turning Analytics on over its API, so 'enable' cannot do the work:
it prints the UI link to click for each project and exits non-zero.`;

export function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const rest = argv.filter((a) => !a.startsWith('--'));
  return {
    command: rest[0],
    projects: rest.slice(1),
    all: flags.has('--all'),
    yes: flags.has('--yes'),
    dryRun: flags.has('--dry-run'),
    unknown: [...flags].filter((f) => !['--all', '--yes', '--dry-run'].includes(f)),
  };
}

// Maps the requested names/ids onto sites, keeping the order asked for.
export function resolveProjects(sites, projects) {
  const byName = new Map(sites.map((s) => [s.name, s]));
  const byId = new Map(sites.map((s) => [s.id, s]));
  const found = [];
  const missing = [];
  for (const p of projects) {
    const site = byName.get(p) || byId.get(p);
    if (site) found.push(site);
    else missing.push(p);
  }
  return { found, missing };
}

function suggest(sites, name) {
  const needle = name.toLowerCase();
  const near = sites
    .map((s) => s.name)
    .filter((n) => n.toLowerCase().includes(needle) || needle.includes(n.toLowerCase()))
    .slice(0, 5);
  return near.length ? ` Did you mean: ${near.join(', ')}?` : '';
}

const pad = (sites) => Math.min(34, Math.max(...sites.map((s) => s.name.length), 4));

function printStatus(sites, log) {
  const width = pad(sites);
  const on = sites.filter((s) => s.analyticsInstanceId);
  for (const s of [...sites].sort((a, b) => a.name.localeCompare(b.name))) {
    log(`  ${s.analyticsInstanceId ? 'on ' : 'off'}  ${s.name.padEnd(width)}  ${s.id}`);
  }
  log(`${on.length}/${sites.length} with Analytics on`);
}

export async function run(argv, { client, log = console.log } = {}) {
  const { command, projects, all, yes, dryRun, unknown } = parseArgs(argv);

  if (!command || command === 'help' || unknown.length) {
    if (unknown.length) log(`Unknown option: ${unknown.join(', ')}\n`);
    log(USAGE);
    return unknown.length || !command ? 1 : 0;
  }
  if (!['status', 'enable', 'disable'].includes(command)) {
    log(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }
  if (command !== 'status') {
    if (all && projects.length) {
      log('Pass either --all or a list of projects, not both.');
      return 1;
    }
    if (!all && !projects.length) {
      log(`${command} needs at least one project, or --all.\n\n${USAGE}`);
      return 1;
    }
    if (all && !yes && !dryRun) {
      log(`--all ${command}s Analytics across every project in the account, and Analytics is`);
      log('billed per project. Re-run with --yes to confirm, or --dry-run to preview.');
      return 1;
    }
  }

  client ||= createNetlifyClient(getToken());
  const sites = await client.listSites();

  let targets = sites;
  if (projects.length) {
    const { found, missing } = resolveProjects(sites, projects);
    for (const name of missing) log(`No project named ${name}.${suggest(sites, name)}`);
    if (missing.length) return 1;
    targets = found;
  }

  if (command === 'status') {
    printStatus(targets, log);
    return 0;
  }

  const wantOn = command === 'enable';
  const changing = targets.filter((s) => Boolean(s.analyticsInstanceId) !== wantOn);
  const width = pad(targets);
  const unchanged = targets.filter((s) => !changing.includes(s));
  // Name them when there are few; past that a count reads better than 20 lines.
  if (unchanged.length > 5) log(`  unchanged  ${unchanged.length} project(s) already ${wantOn ? 'on' : 'off'}`);
  else for (const site of unchanged) log(`  unchanged  ${site.name.padEnd(width)}  already ${wantOn ? 'on' : 'off'}`);
  if (!changing.length) {
    log(`Nothing to do: all ${targets.length} project(s) already ${wantOn ? 'on' : 'off'}.`);
    return 0;
  }
  if (dryRun) {
    for (const site of changing) log(`  would ${command}  ${site.name.padEnd(width)}  ${site.id}`);
    log(`Dry run: ${changing.length} project(s) would change.`);
    return 0;
  }

  if (!wantOn) log('Note: the API can turn Analytics off but not back on; re-enabling is a UI trip.');

  let failed = 0;
  let uiOnly = 0;
  for (const site of changing) {
    try {
      if (wantOn) await client.enableAnalytics(site.id);
      else await client.disableAnalytics(site.id, site.analyticsInstanceId);
      log(`  ${wantOn ? 'enabled ' : 'disabled'}   ${site.name.padEnd(width)}  ${site.id}`);
    } catch (err) {
      if (wantOn && API_PROVISIONING_BLOCKED.test(err.message)) {
        uiOnly++;
        log(`  ui only    ${site.name.padEnd(width)}  ${site.adminUrl}/analytics`);
      } else {
        failed++;
        log(`  FAILED     ${site.name.padEnd(width)}  ${err.message}`);
      }
    }
  }
  const done = changing.length - failed - uiOnly;
  if (uiOnly) {
    log(`Netlify will not provision Analytics over the API, so ${uiOnly} project(s) have to be`);
    log('switched on by hand: open the link above and click Enable analytics.');
  }
  if (done || failed) log(`${done}/${changing.length - uiOnly} ${wantOn ? 'enabled' : 'disabled'}.`);
  if (done && wantOn) log('Run `npm run sync` to pull the new numbers into the dashboard.');
  return failed || uiOnly ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

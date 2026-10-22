import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, DEMO, PORT, ROOT, STALE_MINUTES } from './config.js';
import { historyFile, latestFile, readJson, sync } from './sync.js';

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/vendor/chart.js': ['node_modules/chart.js/dist/chart.umd.min.js', 'text/javascript; charset=utf-8'],
};

let syncing = null;
function runSync() {
  syncing ??= sync().finally(() => { syncing = null; });
  return syncing;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && STATIC[pathname]) {
      const [file, type] = STATIC[pathname];
      return send(res, 200, await fs.readFile(path.join(ROOT, file)), type);
    }
    if (req.method === 'GET' && pathname === '/api/data') {
      const [history, latest] = await Promise.all([
        readJson(historyFile(), { sites: {}, daily: {} }),
        readJson(latestFile(), null),
      ]);
      return send(res, 200, { history, latest, demo: DEMO, syncing: Boolean(syncing) });
    }
    if (req.method === 'POST' && pathname === '/api/sync') {
      await runSync();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`Dashboard: http://localhost:${PORT}${DEMO ? '  (demo data)' : ''}`);
  console.log(`Data directory: ${DATA_DIR}`);
  const latest = await readJson(latestFile(), null);
  const ageMinutes = latest ? (Date.now() - Date.parse(latest.syncedAt)) / 60_000 : Infinity;
  if (ageMinutes > STALE_MINUTES) {
    runSync().catch((err) => console.error(`Sync failed: ${err.message}`));
  }
});

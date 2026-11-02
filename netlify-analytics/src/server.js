import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEMO, HOST, PORT, ROOT, STALE_MINUTES } from './config.js';
import { createStore } from './store.js';
import { dashboardConfig, readDashboardData, runSync, syncing } from './api.js';

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/vendor/chart.js': ['node_modules/chart.js/dist/chart.umd.min.js', 'text/javascript; charset=utf-8'],
};

const store = await createStore();

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
    if (req.method === 'GET' && pathname === '/api/config') {
      return send(res, 200, dashboardConfig());
    }
    if (req.method === 'GET' && pathname === '/api/data') {
      return send(res, 200, { ...(await readDashboardData(store)), syncing: syncing() });
    }
    if (req.method === 'POST' && pathname === '/api/sync') {
      await runSync({ store });
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`Dashboard: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${DEMO ? '  (demo data)' : ''}`);
  console.log(`Data: ${store.describe()}`);
  const latest = await store.read('latest', null);
  const ageMinutes = latest ? (Date.now() - Date.parse(latest.syncedAt)) / 60_000 : Infinity;
  if (ageMinutes > STALE_MINUTES) {
    runSync({ store }).catch((err) => console.error(`Sync failed: ${err.message}`));
  }
});

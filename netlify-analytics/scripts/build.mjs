// Netlify publishes public/ as-is, so the one third-party asset the dashboard
// needs has to be copied in from node_modules first. Locally src/server.js
// serves it straight from node_modules and this step is unnecessary.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(ROOT, 'node_modules/chart.js/dist/chart.umd.min.js');
const to = path.join(ROOT, 'public/vendor/chart.js');

await fs.mkdir(path.dirname(to), { recursive: true });
await fs.copyFile(from, to);
console.log(`Copied chart.js -> ${path.relative(ROOT, to)}`);

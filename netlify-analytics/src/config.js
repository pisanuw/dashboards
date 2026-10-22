import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env file: rely on the real environment.
}

export const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';
export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || (DEMO ? 'data-demo' : 'data'));
export const PORT = Number(process.env.PORT || 3000);
export const SYNC_DAYS = Number(process.env.SYNC_DAYS || 30);
// Re-sync on server start when the last sync is older than this many minutes.
export const STALE_MINUTES = Number(process.env.STALE_MINUTES || 60);

export function getToken() {
  const token = process.env.NETLIFY_TOKEN;
  if (!token) {
    console.error('NETLIFY_TOKEN is not set. Copy .env.example to .env and add a personal access token,');
    console.error('or run `npm run demo` to try the dashboard with fake data.');
    process.exit(1);
  }
  return token;
}

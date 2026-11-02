// Helpers shared by the dashboard's Netlify functions.

import { CRON_SECRET } from '../../src/config.js';

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// The background sync is reachable at its own URL, which the edge auth gate
// deliberately does not cover (the scheduler is not a browser and has no
// password). A shared secret is what keeps it from being a free "run this
// expensive job" button for anyone who guesses the path.
export function cronSecretOk(req) {
  if (!CRON_SECRET) return true; // Nothing configured: nothing to check.
  const header = req.headers.get('x-cron-secret') || '';
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return timingSafeEqual(header || bearer, CRON_SECRET);
}

// Compares without leaking the position of the first mismatch through timing.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Asks the background sync to start. It answers 202 straight away and keeps
// running for up to 15 minutes, which a 30-second scheduled function cannot.
export async function triggerBackgroundSync(req) {
  const url = new URL('/.netlify/functions/sync-background', req.url);
  const res = await fetch(url, {
    method: 'POST',
    headers: CRON_SECRET ? { 'x-cron-secret': CRON_SECRET } : {},
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`Could not start background sync: HTTP ${res.status}`);
  }
  return url.toString();
}

// The dashboard reports traffic for every project in the account, and a
// Netlify site is public by default. Netlify's own password protection is a
// paid feature, so this is the free equivalent: HTTP Basic auth at the edge,
// in front of the page, the static assets and the API alike.
//
// Set DASHBOARD_PASSWORD to turn it on. With no password set the site stays
// open, which is fine for a deploy preview and not for a public URL.

const REALM = 'Netlify Analytics';

// Compares without leaking the position of the first mismatch through timing.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async (request) => {
  const password = Netlify.env.get('DASHBOARD_PASSWORD');
  if (!password) return; // Not configured: let everything through.

  const user = Netlify.env.get('DASHBOARD_USER') || 'admin';
  const expected = `Basic ${btoa(`${user}:${password}`)}`;
  const offered = request.headers.get('authorization') || '';

  if (timingSafeEqual(offered, expected)) return; // Continue to the origin.

  return new Response('Authentication required.\n', {
    status: 401,
    headers: {
      'www-authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'content-type': 'text/plain; charset=utf-8',
    },
  });
};

export const config = {
  path: '/*',
  // The scheduler is not a browser and has no password. Only the background
  // sync is exempt, and it checks CRON_SECRET itself. Everything else under
  // /.netlify/ stays behind the gate, including the default
  // /.netlify/functions/data URL that would otherwise sidestep it.
  excludedPath: '/.netlify/functions/sync-background',
};

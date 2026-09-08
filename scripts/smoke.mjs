/**
 * Post-deployment smoke test.
 *
 * Points at a live deployment and verifies the things that actually matter
 * after a deploy: the gate refuses strangers and admits the password, a
 * signup lands, the admin panel opens, an export downloads, and the security
 * headers survived whatever proxy sits in front.
 *
 * Safe to run against production: it creates one clearly-labelled entry and
 * tells you how to remove it.
 *
 * Usage:
 *   node scripts/smoke.mjs --base https://your-app.example.com \
 *                          --gate-password ... --admin-password ...
 */
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const BASE = (args.get('base') ?? process.env.SMOKE_BASE ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const GATE_PASSWORD = args.get('gate-password') ?? process.env.SITE_GATE_PASSWORD;
const ADMIN_PASSWORD = args.get('admin-password') ?? process.env.ADMIN_PASSWORD;
const APP = args.get('app') ?? 'pages';

if (!GATE_PASSWORD || !ADMIN_PASSWORD) {
  console.error('Both --gate-password and --admin-password are required (or set them in the environment).');
  process.exit(2);
}

const cookies = new Map();
let csrf = null;
let passed = 0;
let failed = 0;

function cookieHeader() {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function call(method, path, { body, headers = {} } = {}) {
  const requestHeaders = { Accept: 'application/json', Origin: BASE, ...headers };
  const jar = cookieHeader();
  if (jar) requestHeaders.Cookie = jar;
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (csrf && method !== 'GET') requestHeaders['X-CSRF-Token'] = csrf;

  const response = await fetch(BASE + path, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });

  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    const [pair] = cookie.split(';');
    const eq = pair.indexOf('=');
    cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text();

  return { status: response.status, headers: response.headers, body: payload };
}

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log(`Smoke test → ${BASE}\n`);

// ---- reachability -------------------------------------------------
console.log('Reachability');
const health = await call('GET', '/healthz');
check('liveness probe answers', health.status === 200 && health.body?.ok === true, `status ${health.status}`);
const ready = await call('GET', '/readyz');
check('readiness probe answers (database reachable)', ready.status === 200, `status ${ready.status}`);

// ---- the gate -----------------------------------------------------
console.log('\nSite gate');
const blocked = await call('GET', `/api/v1/apps/${APP}/count`);
check('the API is closed without a session', blocked.status === 401, `status ${blocked.status}`);

const wrong = await call('POST', '/api/v1/gate/login', { body: { password: `${GATE_PASSWORD}-wrong` } });
check('a wrong password is refused', wrong.status === 401, `status ${wrong.status}`);

const unlocked = await call('POST', '/api/v1/gate/login', { body: { password: GATE_PASSWORD } });
check('the correct password is accepted', unlocked.status === 200 && unlocked.body?.ok === true, `status ${unlocked.status}`);
check('a session cookie was issued', cookies.has('wl_gate'));

// ---- the landing page ---------------------------------------------
console.log('\nLanding page');
const page = await fetch(`${BASE}/a/${APP}/`, { headers: { Cookie: cookieHeader() } });
const pageBody = await page.text();
check('the landing page loads', page.status === 200, `status ${page.status}`);
check('it is the real page', pageBody.includes('<!doctype html>') || pageBody.includes('<!DOCTYPE html>'));

const count = await call('GET', `/api/v1/apps/${APP}/count`);
check('the counter reads', count.status === 200 && typeof count.body?.count === 'number', `status ${count.status}`);

// ---- signup --------------------------------------------------------
console.log('\nSignup');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const email = `smoke-test-${stamp}@example.com`;
const signup = await call('POST', `/api/v1/apps/${APP}/waitlist`, {
  body: { name: `SMOKE TEST ${stamp}`, email, phone: '010-0000-0000', source: 'smoke-test' },
});
check('a signup is accepted', signup.status === 201 && signup.body?.ok === true, `status ${signup.status}`);
check('it is given a position', typeof signup.body?.position === 'number', String(signup.body?.position));

const duplicate = await call('POST', `/api/v1/apps/${APP}/waitlist`, { body: { name: 'Again', email } });
check('a repeat signup returns the same position', duplicate.body?.duplicate === true && duplicate.body?.position === signup.body?.position);

const invalid = await call('POST', `/api/v1/apps/${APP}/waitlist`, { body: { name: 'Bad', email: 'nonsense' } });
check('an invalid address is rejected', invalid.status === 400, `status ${invalid.status}`);

// ---- admin ---------------------------------------------------------
console.log('\nAdmin panel');
const adminBlocked = await call('GET', '/api/v1/admin/overview');
check('the admin API is closed without its password', adminBlocked.status === 401, `status ${adminBlocked.status}`);

const gateAsAdmin = await call('POST', '/api/v1/admin/login', { body: { password: GATE_PASSWORD } });
check('the gate password does not open the admin panel', gateAsAdmin.status === 401, `status ${gateAsAdmin.status}`);

const adminLogin = await call('POST', '/api/v1/admin/login', { body: { password: ADMIN_PASSWORD } });
if (adminLogin.body?.csrfToken) csrf = adminLogin.body.csrfToken;
check('the admin password is accepted', adminLogin.status === 200, `status ${adminLogin.status}`);

const overview = await call('GET', '/api/v1/admin/overview');
check('the overview loads', overview.status === 200 && typeof overview.body?.totals?.total === 'number', `status ${overview.status}`);
if (overview.status === 200) {
  console.log(`        ${overview.body.totals.total} entries across ${overview.body.apps.length} app(s), storage: ${overview.body.server.dialect}`);
}

const entries = await call('GET', `/api/v1/admin/entries?search=${encodeURIComponent(email)}`);
check('the new signup appears in the admin list', entries.body?.total === 1, `found ${entries.body?.total}`);

const held = csrf;
csrf = null;
const noCsrf = await call('PATCH', `/api/v1/admin/entries/${entries.body?.entries?.[0]?.id ?? 0}`, { body: { status: 'invited' } });
check('a write without a CSRF token is refused', noCsrf.status === 403, `status ${noCsrf.status}`);
csrf = held;

// ---- exports --------------------------------------------------------
console.log('\nExports');
for (const format of ['csv', 'xlsx', 'json']) {
  const response = await fetch(`${BASE}/api/v1/admin/entries/export?format=${format}`, {
    headers: { Cookie: cookieHeader() },
  });
  const bytes = (await response.arrayBuffer()).byteLength;
  check(
    `${format} export downloads`,
    response.status === 200 && bytes > 0 && /attachment/.test(response.headers.get('content-disposition') ?? ''),
    `status ${response.status}, ${bytes} bytes`,
  );
}

// ---- security headers ------------------------------------------------
console.log('\nSecurity headers');
const headers = health.headers;
check('Content-Security-Policy is set', /default-src 'none'/.test(headers.get('content-security-policy') ?? ''));
check('X-Content-Type-Options: nosniff', headers.get('x-content-type-options') === 'nosniff');
check('X-Frame-Options: DENY', headers.get('x-frame-options') === 'DENY');
check('the stack is not advertised', !headers.get('x-powered-by'));
if (BASE.startsWith('https://')) {
  check('Strict-Transport-Security is set', Boolean(headers.get('strict-transport-security')));
} else {
  console.log('  SKIP  Strict-Transport-Security (only sent over HTTPS)');
}

const crossOrigin = await call('POST', `/api/v1/apps/${APP}/waitlist`, {
  body: { name: 'Cross Origin', email: 'xo@example.com' },
  headers: { Origin: 'https://evil.example' },
});
check('a cross-origin write is refused', crossOrigin.status === 403, `status ${crossOrigin.status}`);

// ---- summary ---------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (!failed) {
  console.log(`\nThe deployment is healthy.`);
  console.log(`Remove the test entry from the admin panel by searching for: ${email}`);
}
process.exit(failed ? 1 : 0);

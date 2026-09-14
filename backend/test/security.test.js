/**
 * Security behaviour of the two perimeters.
 *
 * These are the tests that would fail loudly if someone later "simplified"
 * the gate, the CSRF check or the origin check away.
 */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import { ADMIN_PASSWORD, GATE_PASSWORD, startTestServer } from './helpers.js';

let server;
before(async () => { server = await startTestServer(); });
after(async () => { await server.stop(); });

describe('site gate', () => {
  test('blocks the public API until the password is given', async () => {
    const client = server.client();
    const blocked = await client.get('/api/v1/apps/pages/count');
    assert.equal(blocked.status, 401);
    assert.equal(blocked.body.error, 'gate_required');

    const unlocked = await client.unlockGate();
    assert.equal(unlocked.status, 200);
    assert.ok(client.hasCookie('wl_gate'), 'gate cookie should be set');

    const allowed = await client.get('/api/v1/apps/pages/count');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.ok, true);
  });

  test('redirects a page request to the gate, preserving the destination', async () => {
    const client = server.client();
    const response = await client.get('/a/pages/', { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 302);
    assert.equal(response.location, '/gate?next=%2Fa%2Fpages%2F');
  });

  test('refuses the wrong password without revealing anything', async () => {
    const client = server.client();
    const response = await client.post('/api/v1/gate/login', { password: 'not-the-password' });
    assert.equal(response.status, 401);
    assert.equal(response.body.message, 'Incorrect password.');
    assert.ok(!client.hasCookie('wl_gate'));
  });

  test('does not accept the admin password at the gate', async () => {
    const client = server.client();
    const response = await client.post('/api/v1/gate/login', { password: ADMIN_PASSWORD });
    assert.equal(response.status, 401);
  });

  test('logout invalidates the session server-side, not just the cookie', async () => {
    const client = server.client();
    await client.unlockGate();
    const cookieValue = client.cookies.get('wl_gate');

    await client.post('/api/v1/gate/logout');
    assert.ok(!client.hasCookie('wl_gate'), 'cookie should be cleared');

    // Replay the old cookie: a revoked session must stay revoked.
    client.cookies.set('wl_gate', cookieValue);
    const replay = await client.get('/api/v1/apps/pages/count');
    assert.equal(replay.status, 401, 'a revoked session must not be replayable');
  });

  test('a forged session token is rejected', async () => {
    const client = server.client();
    await client.unlockGate();
    const [id] = client.cookies.get('wl_gate').split('.');
    client.cookies.set('wl_gate', `${id}.${'f'.repeat(43)}`);

    const response = await client.get('/api/v1/apps/pages/count');
    assert.equal(response.status, 401, 'a valid id with a wrong token must not authenticate');
  });
});

describe('admin gate', () => {
  test('requires its own password on top of the site gate', async () => {
    const client = server.client();
    await client.unlockGate();

    const blocked = await client.get('/api/v1/admin/overview');
    assert.equal(blocked.status, 401);
    assert.equal(blocked.body.error, 'admin_auth_required');

    const wrong = await client.post('/api/v1/admin/login', { password: GATE_PASSWORD });
    assert.equal(wrong.status, 401, 'the gate password must not open the admin panel');

    const ok = await client.signInAdmin();
    assert.equal(ok.status, 200);
    assert.ok(ok.body.csrfToken);

    const overview = await client.get('/api/v1/admin/overview');
    assert.equal(overview.status, 200);
  });

  test('rejects a state-changing request with no CSRF token', async () => {
    const client = server.client();
    await client.unlockGate();
    await client.signInAdmin();

    const response = await client.patch('/api/v1/admin/apps/1', { name: 'Renamed' }, { csrf: false });
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'csrf_invalid');
  });

  test('rejects a CSRF token belonging to a different session', async () => {
    const one = server.client();
    await one.unlockGate();
    await one.signInAdmin();

    const two = server.client();
    await two.unlockGate();
    await two.signInAdmin();

    two.csrf = one.csrf;
    const response = await two.patch('/api/v1/admin/apps/1', { name: 'Renamed' });
    assert.equal(response.status, 403, "another session's token must not be accepted");
  });

  test('reads are permitted without a CSRF token', async () => {
    const client = server.client();
    await client.unlockGate();
    await client.signInAdmin();
    client.csrf = null;

    const response = await client.get('/api/v1/admin/entries');
    assert.equal(response.status, 200);
  });
});

describe('cross-origin and injection', () => {
  test('refuses a state-changing request from another origin', async () => {
    const client = server.client();
    await client.unlockGate();

    const response = await client.post(
      '/api/v1/apps/pages/waitlist',
      { name: 'Attacker', email: 'attacker@example.com' },
      { headers: { Origin: 'https://evil.example' } },
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'cross_origin_refused');
  });

  test('the gate does not become an open redirect', async () => {
    const client = server.client();
    for (const hostile of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const response = await client.get(`/gate?next=${encodeURIComponent(hostile)}`, {
        headers: { Accept: 'text/html' },
      });
      // Not yet authenticated, so the gate page renders; once unlocked the
      // redirect target is what matters, checked below.
      assert.equal(response.status, 200);
    }

    await client.unlockGate();
    const redirect = await client.get('/gate?next=https%3A%2F%2Fevil.example', {
      headers: { Accept: 'text/html' },
    });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.location, '/', 'an off-site destination must collapse to /');
  });

  test('a sort parameter cannot reach the SQL text', async () => {
    const client = server.client();
    await client.unlockGate();
    await client.signInAdmin();

    const response = await client.get(
      '/api/v1/admin/entries?sort=' + encodeURIComponent('position; DROP TABLE entries--'),
    );
    assert.equal(response.status, 200, 'the injected sort should fall back, not error');

    // The table must still be there.
    const after = await client.get('/api/v1/admin/entries');
    assert.equal(after.status, 200);
    assert.equal(typeof after.body.total, 'number');
  });

  test('security headers are present on every response', async () => {
    const client = server.client();
    const response = await client.get('/healthz');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(response.headers.get('x-powered-by'), null, 'the stack should not be advertised');
  });

  test('an oversized body is refused', async () => {
    const client = server.client();
    await client.unlockGate();
    const response = await client.post('/api/v1/apps/pages/waitlist', {
      name: 'x'.repeat(40_000),
      email: 'big@example.com',
    });
    assert.equal(response.status, 413);
  });
});

describe('login lockout', () => {
  test('locks out after repeated failures and says how long to wait', async () => {
    // A dedicated server so this test's failures do not affect the others.
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      let locked = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await client.post('/api/v1/gate/login', { password: `wrong-${attempt}` });
        if (response.status === 429) { locked = response; break; }
      }
      assert.ok(locked, 'repeated failures should trigger a lockout');
      assert.equal(locked.body.error, 'locked_out');
      assert.ok(locked.body.retryAfterSeconds > 0);
      assert.ok(locked.headers.get('retry-after'));
    } finally {
      await isolated.stop();
    }
  });
});

describe('session hygiene', () => {
  test('signing in again retires the previous session', async () => {
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      await client.unlockGate();
      const firstCookie = client.cookies.get('wl_gate');

      // A second sign-in from the same client, as happens when someone
      // re-authenticates because they suspect their session was captured.
      await client.unlockGate();
      const secondCookie = client.cookies.get('wl_gate');
      assert.notEqual(firstCookie, secondCookie, 'a new session should be issued');

      // The captured cookie must no longer work.
      const attacker = isolated.client();
      attacker.cookies.set('wl_gate', firstCookie);
      const replay = await attacker.get('/api/v1/apps/pages/count');
      assert.equal(replay.status, 401, 'the superseded session must be revoked');

      // The current one still does.
      const current = await client.get('/api/v1/apps/pages/count');
      assert.equal(current.status, 200);
    } finally {
      await isolated.stop();
    }
  });

  test('session cookies carry the expected attributes', async () => {
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      const response = await client.post('/api/v1/gate/login', { password: GATE_PASSWORD });
      const [cookie] = response.headers.getSetCookie();
      assert.match(cookie, /HttpOnly/, 'must not be readable from JavaScript');
      assert.match(cookie, /SameSite=Lax/, 'the gate cookie is Lax so inbound links work');
      assert.match(cookie, /Path=\//);

      const adminResponse = await client.post('/api/v1/admin/login', { password: ADMIN_PASSWORD });
      const adminCookie = adminResponse.headers.getSetCookie().find((c) => c.startsWith('wl_admin'));
      assert.match(adminCookie, /HttpOnly/);
      assert.match(adminCookie, /SameSite=Strict/, 'the admin cookie takes the stricter setting');
    } finally {
      await isolated.stop();
    }
  });
});

describe('transport security', () => {
  test('HSTS is withheld over plain HTTP and sent over HTTPS', async () => {
    // Over plain HTTP it must be absent. Sending it would make the browser
    // remember the pin and render a local development server unreachable.
    const plain = await server.client().get('/healthz');
    assert.equal(plain.headers.get('strict-transport-security'), null);

    // Behind a TLS-terminating proxy the connection genuinely is HTTPS, and
    // the header must be sent even though NODE_ENV is not 'production'.
    const proxied = await startTestServer({ TRUST_PROXY_HOPS: '1' });
    try {
      const response = await proxied.client().get('/healthz', {
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      assert.match(
        response.headers.get('strict-transport-security') ?? '',
        /max-age=\d+/,
        'a forwarded HTTPS request should be pinned',
      );
    } finally {
      await proxied.stop();
    }
  });

  test('a forged X-Forwarded-Proto is ignored when no proxy is trusted', async () => {
    // With TRUST_PROXY_HOPS=0 the header is attacker-controlled noise and
    // must not be able to change how the response is built.
    const response = await server.client().get('/healthz', {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(response.headers.get('strict-transport-security'), null);
  });
});

describe('base path', () => {
  const BASE = '/r2p/waitlist';

  test('the whole site moves under the prefix, and nothing is left at the root', async () => {
    const isolated = await startTestServer({ BASE_PATH: BASE });
    try {
      const client = isolated.client();

      // Outside the prefix belongs to whatever else shares the origin.
      for (const outside of ['/', '/admin', '/healthz', '/api/v1/apps']) {
        const response = await client.get(outside, { headers: { Accept: 'text/html' } });
        assert.equal(response.status, 404, `${outside} should not be served`);
      }

      // Health probes stay outside the gate but inside the prefix.
      const health = await client.get(`${BASE}/healthz`);
      assert.equal(health.status, 200);

      const unlocked = await client.post(`${BASE}/api/v1/gate/login`, { password: GATE_PASSWORD });
      assert.equal(unlocked.status, 200);

      const count = await client.get(`${BASE}/api/v1/apps/pages/count`);
      assert.equal(count.status, 200);
      assert.equal(typeof count.body.count, 'number');
    } finally {
      await isolated.stop();
    }
  });

  test('the session cookie is scoped to the prefix', async () => {
    const isolated = await startTestServer({ BASE_PATH: BASE });
    try {
      const client = isolated.client();
      const response = await client.post(`${BASE}/api/v1/gate/login`, { password: GATE_PASSWORD });
      const [cookie] = response.headers.getSetCookie();
      // Scoping matters twice over: the browser must send it for our pages,
      // and must not leak it to anything else sharing the origin.
      assert.match(cookie, new RegExp(`Path=${BASE}/`), cookie);
    } finally {
      await isolated.stop();
    }
  });

  test('the gate redirect keeps the prefix, and refuses to leave it', async () => {
    const isolated = await startTestServer({ BASE_PATH: BASE });
    try {
      const client = isolated.client();

      const blocked = await client.get(`${BASE}/a/pages/`, { headers: { Accept: 'text/html' } });
      assert.equal(blocked.status, 302);
      assert.equal(blocked.location, `${BASE}/gate?next=${encodeURIComponent(`${BASE}/a/pages/`)}`);

      await client.post(`${BASE}/api/v1/gate/login`, { password: GATE_PASSWORD });

      // A destination outside the prefix is somebody else's site.
      const escaping = await client.get(`${BASE}/gate?next=%2Fsomewhere-else`, {
        headers: { Accept: 'text/html' },
      });
      assert.equal(escaping.status, 302);
      assert.equal(escaping.location, `${BASE}/`, 'must collapse to the site root, not the origin root');

      const offSite = await client.get(`${BASE}/gate?next=https%3A%2F%2Fevil.example`, {
        headers: { Accept: 'text/html' },
      });
      assert.equal(offSite.location, `${BASE}/`);
    } finally {
      await isolated.stop();
    }
  });

  test('the prefix without a trailing slash redirects once, not forever', async () => {
    // Express matches a path and its trailing-slash form identically, so a
    // naive redirect sends /r2p/waitlist/ to itself. That is an infinite loop
    // for anyone who typed the URL correctly.
    const isolated = await startTestServer({ BASE_PATH: BASE });
    try {
      const client = isolated.client();
      await client.post(`${BASE}/api/v1/gate/login`, { password: GATE_PASSWORD });

      const bare = await client.get(BASE, { headers: { Accept: 'text/html' } });
      assert.equal(bare.status, 301);
      assert.equal(bare.location, `${BASE}/`);

      const withSlash = await client.get(`${BASE}/`, { headers: { Accept: 'text/html' } });
      assert.equal(withSlash.status, 200, 'the trailing-slash form must be served, not redirected');
    } finally {
      await isolated.stop();
    }
  });

  test('a signup works end to end under the prefix', async () => {
    const isolated = await startTestServer({ BASE_PATH: BASE });
    try {
      const client = isolated.client();
      await client.post(`${BASE}/api/v1/gate/login`, { password: GATE_PASSWORD });

      const signup = await client.post(`${BASE}/api/v1/apps/cdots/waitlist`, { email: 'prefixed@example.com' });
      assert.equal(signup.status, 201);
      assert.equal(signup.body.position, 1);

      const admin = isolated.client();
      await admin.post(`${BASE}/api/v1/gate/login`, { password: GATE_PASSWORD });
      const login = await admin.post(`${BASE}/api/v1/admin/login`, { password: ADMIN_PASSWORD });
      admin.csrf = login.body.csrfToken;

      const list = await admin.get(`${BASE}/api/v1/admin/entries?search=prefixed`);
      assert.equal(list.body.total, 1);
    } finally {
      await isolated.stop();
    }
  });

  test('a malformed BASE_PATH is refused at boot rather than half-applied', async () => {
    await assert.rejects(() => startTestServer({ BASE_PATH: '/r2p/../etc' }));
    await assert.rejects(() => startTestServer({ BASE_PATH: '/has spaces' }));
  });
});

describe('install assets and the gate', () => {
  test('a manifest and its icons are reachable without a session', async () => {
    // A browser fetches a manifest with credentials omitted. Behind a gate
    // that redirects, it receives the login page instead of JSON and reports
    // the app as not installable -- silently, with nothing on the page to
    // explain it. These are branding only: a name and a logo.
    const client = server.client();
    for (const asset of [
      '/manifest.webmanifest',
      '/a/pages/manifest.webmanifest',
      '/a/cdots/manifest.webmanifest',
      '/icons/icon-192.png',
      '/a/pages/icons/icon-512.png',
      '/a/cdots/icons/icon-192.png',
    ]) {
      const response = await client.get(asset);
      assert.equal(response.status, 200, `${asset} must be served without a session`);
    }
  });

  test('the exemption covers branding and nothing else', async () => {
    const client = server.client();
    // Everything that carries data, or accepts it, stays behind the gate.
    for (const [path, expected] of [
      ['/', 302],
      ['/a/pages/', 302],
      ['/a/cdots/', 302],
      ['/a/cdots/index.html', 302],
      ['/a/cdots/sw.js', 302],
      ['/a/cdots/assets/logo.svg', 302],
      ['/admin', 302],
    ]) {
      const response = await client.get(path, { headers: { Accept: 'text/html' } });
      assert.equal(response.status, expected, `${path} must stay gated`);
    }

    const api = await client.get('/api/v1/apps');
    assert.equal(api.status, 401, 'the API must stay gated');
  });

  test('the exemption cannot be widened by a crafted path', async () => {
    const client = server.client();
    for (const attempt of [
      '/a/pages/icons/../index.html',
      '/a/pages/icons/../../../backend/src/config.js',
      '/icons/../manifest.webmanifest/../../.env',
      '/a/pages/manifest.webmanifest/../index.html',
    ]) {
      const response = await client.get(attempt, { headers: { Accept: 'text/html' } });
      assert.notEqual(response.status, 200, `${attempt} must not be served`);
      const body = String(response.body ?? '');
      assert.ok(!body.includes('SESSION_SECRET'), 'must never serve the environment file');
      assert.ok(!body.includes('베타 테스터'), 'must never serve a gated page');
    }
  });
});

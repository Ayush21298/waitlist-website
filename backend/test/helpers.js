/**
 * Test harness: boots a real server on an ephemeral port against a temporary
 * SQLite file, and hands back a small HTTP client that keeps cookies.
 *
 * Deliberately end-to-end rather than mocked. The defects worth catching here
 * -- a session that does not stick, a CSRF check that never fires, a position
 * assigned twice under load -- only show up when the real middleware stack,
 * the real cookie jar and the real database are all in play.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuthService, parseCookies } from '../src/middleware/auth.js';
import { buildConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createStore } from '../src/db/index.js';
import { Logger } from '../src/logger.js';
import { SEED_APPS } from '../src/seed.js';

export const GATE_PASSWORD = 'test-gate-password';
export const ADMIN_PASSWORD = 'test-admin-password';

/**
 * Boots an isolated server. Call `stop()` when finished.
 *
 * Runs on SQLite by default. Set TEST_DATABASE_URL to exercise the Postgres
 * adapter instead: each server then gets its own schema, so the suites stay
 * isolated from one another inside a single database. Both adapters must pass
 * the same tests, which is the only way to trust that a deployment moving
 * from a local file to managed Postgres behaves identically.
 */
export async function startTestServer(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waitlist-test-'));

  let schema = null;
  let databaseUrl = '';
  const postgresUrl = process.env.TEST_DATABASE_URL;
  if (postgresUrl) {
    schema = `t_${crypto.randomBytes(6).toString('hex')}`;
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.end();

    const url = new URL(postgresUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = url.toString();
  }

  const env = {
    NODE_ENV: 'test',
    DATA_DIR: dir,
    LOG_DIR: path.join(dir, 'logs'),
    LOG_TO_FILE: 'false',
    LOG_TO_CONSOLE: 'false',
    SITE_GATE_PASSWORD: GATE_PASSWORD,
    ADMIN_PASSWORD,
    SESSION_SECRET: 'a'.repeat(48),
    IP_HASH_SECRET: 'b'.repeat(48),
    // scrypt is intentionally slow in production; a test suite that pays that
    // cost on every login stops being run.
    SCRYPT_N: '1024',
    DATABASE_URL: databaseUrl,
    ...overrides,
  };

  const config = buildConfig(env);
  const logger = new Logger({ level: 'error', sinks: [] });
  const { adapter, store } = await createStore(config, logger);
  await store.ensureApps(SEED_APPS);

  const auth = new AuthService({ config, store, logger });
  await auth.init();

  const app = createApp({ config, store, auth, logger });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    config,
    store,
    client: () => new TestClient(base),
    async stop() {
      app.stopBackgroundWork?.();
      await new Promise((resolve) => server.close(resolve));
      await adapter.close();
      if (schema) {
        const { default: pg } = await import('pg');
        const client = new pg.Client({ connectionString: postgresUrl });
        await client.connect();
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await client.end();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Minimal cookie-retaining HTTP client. */
export class TestClient {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = null;
  }

  #cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  #store(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const cookie of raw) {
      const [pair] = cookie.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // Max-Age=0 is a deletion; mirror what a browser would do.
      if (/Max-Age=0(?:;|$)/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method, path, { body, headers = {}, origin = true, csrf = true } = {}) {
    const requestHeaders = { Accept: 'application/json', ...headers };
    const cookie = this.#cookieHeader();
    if (cookie) requestHeaders.Cookie = cookie;
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    // Default to a same-origin request, but never clobber an Origin the
    // caller set deliberately -- that is the whole point of a CSRF test.
    if (origin && requestHeaders.Origin === undefined) requestHeaders.Origin = this.base;
    if (csrf && this.csrf && method !== 'GET') requestHeaders['X-CSRF-Token'] = this.csrf;

    const response = await fetch(this.base + path, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    this.#store(response);

    const contentType = response.headers.get('content-type') ?? '';
    let payload = null;
    if (contentType.includes('application/json')) payload = await response.json().catch(() => null);
    else payload = await response.text();

    return { status: response.status, headers: response.headers, body: payload, location: response.headers.get('location') };
  }

  get(path, options) { return this.request('GET', path, options); }
  post(path, body, options) { return this.request('POST', path, { ...options, body }); }
  patch(path, body, options) { return this.request('PATCH', path, { ...options, body }); }
  delete(path, options) { return this.request('DELETE', path, options); }

  async unlockGate(password = GATE_PASSWORD) {
    return this.post('/api/v1/gate/login', { password });
  }

  async signInAdmin(password = ADMIN_PASSWORD) {
    const response = await this.post('/api/v1/admin/login', { password });
    if (response.body?.csrfToken) this.csrf = response.body.csrfToken;
    return response;
  }

  hasCookie(name) {
    return this.cookies.has(name);
  }
}

export { parseCookies };

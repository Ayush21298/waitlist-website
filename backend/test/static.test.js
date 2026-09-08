/**
 * Static asset serving: compression, caching, conditional requests, and the
 * path-traversal defence.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before, describe } from 'node:test';
import path from 'node:path';
import zlib from 'node:zlib';

import { resolveWithin } from '../src/middleware/static.js';
import { startTestServer } from './helpers.js';

let server;
let cookie;

before(async () => {
  server = await startTestServer();
  const client = server.client();
  await client.unlockGate();
  cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
});
after(async () => { await server.stop(); });

/**
 * Raw HTTP, deliberately not fetch().
 *
 * Undici transparently decodes Content-Encoding, which would make every
 * assertion here vacuous: the test would decompress an already-decompressed
 * body and could never tell whether the server compressed anything at all.
 * node:http hands back exactly the bytes on the wire.
 */
function raw(pathname, headers = {}) {
  const url = new URL(server.base + pathname);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: headers.method ?? 'GET',
        headers: { Cookie: cookie, ...headers },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

describe('compression', () => {
  test('serves the landing page compressed when the client accepts it', async () => {
    const response = await raw('/a/pages/', { 'Accept-Encoding': 'br, gzip' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'br');
    assert.match(response.headers.vary ?? '', /Accept-Encoding/);

    const decoded = zlib.brotliDecompressSync(response.body).toString('utf8');
    assert.match(decoded, /베타 테스터 대기 신청/, 'the decompressed page must be the real one');
    assert.ok(
      response.body.length < decoded.length * 0.85,
      `compression should reduce size: ${response.body.length} vs ${decoded.length}`,
    );
  });

  test('falls back to gzip, then to identity', async () => {
    const gzipped = await raw('/a/pages/', { 'Accept-Encoding': 'gzip' });
    assert.equal(gzipped.headers['content-encoding'], 'gzip');
    assert.match(zlib.gunzipSync(gzipped.body).toString('utf8'), /<!doctype html>/i);

    const plain = await raw('/a/pages/', { 'Accept-Encoding': 'identity' });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.match(plain.body.toString('utf8'), /<!doctype html>/i);
  });

  test('honours a conditional request', async () => {
    const first = await raw('/a/pages/', { 'Accept-Encoding': 'br' });
    const etag = first.headers.etag;
    assert.ok(etag, 'an ETag should be issued');

    const second = await raw('/a/pages/', { 'Accept-Encoding': 'br', 'If-None-Match': etag });
    assert.equal(second.status, 304, 'an unchanged asset should not be re-sent');
    assert.equal(second.body.length, 0);
  });

  test('sets an accurate Content-Length for the encoded body', async () => {
    const response = await raw('/a/pages/', { 'Accept-Encoding': 'br' });
    assert.equal(Number(response.headers['content-length']), response.body.length);
  });

  test('compresses the gate page too', async () => {
    // Without the gate cookie, /gate renders the login page rather than
    // redirecting an already-authenticated visitor away.
    const html = await raw('/gate', { 'Accept-Encoding': 'br', Cookie: '' });
    assert.equal(html.status, 200);
    assert.equal(html.headers['content-encoding'], 'br');
    assert.match(zlib.brotliDecompressSync(html.body).toString('utf8'), /접속 비밀번호/);
  });
});

describe('path traversal', () => {
  test('resolveWithin refuses to escape the root', () => {
    const root = path.resolve('/home/ss/workspace/R2P/Openlab/waitlist-website/frontend');
    const hostile = [
      '/../../../etc/passwd',
      '/../backend/src/config.js',
      '/..%2f..%2fetc%2fpasswd',
      '/apps/../../.env',
      '/\0/etc/passwd',
    ];
    for (const attempt of hostile) {
      assert.equal(resolveWithin(root, attempt), null, `should refuse ${attempt}`);
    }

    const legitimate = resolveWithin(root, '/gate/index.html');
    assert.ok(legitimate, 'a normal path inside the root should resolve');
  });

  test('the served routes refuse to escape their mount', async () => {
    for (const attempt of [
      '/a/../../.env',
      '/a/%2e%2e%2f%2e%2e%2f.env',
      '/admin/../../backend/src/config.js',
      '/a/pages/../../../package.json',
    ]) {
      const response = await raw(attempt);
      assert.ok(
        response.status !== 200,
        `${attempt} should not return a file, got ${response.status}`,
      );
      const text = response.body.toString('utf8');
      assert.ok(!text.includes('SESSION_SECRET'), 'must never serve the environment file');
      assert.ok(!text.includes('siteGatePassword'), 'must never serve backend source');
    }
  });

  test('dotfiles are not served', async () => {
    const response = await raw('/a/.env');
    assert.notEqual(response.status, 200);
  });
});

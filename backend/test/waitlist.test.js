/**
 * Waitlist behaviour: signup, validation, multi-tenancy, admin management
 * and exports.
 */
import assert from 'node:assert/strict';
import test, { after, before, beforeEach, describe } from 'node:test';
import zlib from 'node:zlib';

import { startTestServer } from './helpers.js';

let server;
let admin;

before(async () => {
  server = await startTestServer();
  admin = server.client();
  await admin.unlockGate();
  await admin.signInAdmin();
});
after(async () => { await server.stop(); });

/** A gate-authenticated visitor. */
async function visitor() {
  const client = server.client();
  await client.unlockGate();
  return client;
}

/**
 * Creates an app with exactly the settings a test needs.
 *
 * Tests that depend on an app collecting a phone number, or having no
 * capacity, used to lean on however the seeded Pages app happened to be
 * configured. That made them break the moment its design changed -- which is
 * a property of the fixture, not of the behaviour under test.
 */
async function makeApp(isolated, definition) {
  const admin = isolated.client();
  await admin.unlockGate();
  await admin.signInAdmin();
  const created = await admin.post('/api/v1/admin/apps', definition);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.app;
}

describe('signup', () => {
  test('accepts a valid signup and assigns position 1 first', async () => {
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      await client.unlockGate();
      const response = await client.post('/api/v1/apps/pages/waitlist', {
        name: '홍길동',
        email: 'Hong@Example.COM',
        phone: '010-1234-5678',
      });
      assert.equal(response.status, 201);
      assert.equal(response.body.position, 1);
      assert.equal(response.body.duplicate, false);
    } finally {
      await isolated.stop();
    }
  });

  test('treats email as case-insensitive for duplicates but preserves what was typed', async () => {
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      await client.unlockGate();
      await client.post('/api/v1/apps/pages/waitlist', { name: 'First', email: 'Case@Example.com' });

      const repeat = await client.post('/api/v1/apps/pages/waitlist', { name: 'Second', email: 'CASE@example.COM' });
      assert.equal(repeat.status, 200);
      assert.equal(repeat.body.duplicate, true);
      assert.equal(repeat.body.position, 1, 'should return the original position');

      const adminClient = isolated.client();
      await adminClient.unlockGate();
      await adminClient.signInAdmin();
      const list = await adminClient.get('/api/v1/admin/entries');
      assert.equal(list.body.total, 1, 'no second row should have been created');
      assert.equal(list.body.entries[0].email, 'Case@example.com', 'local part keeps its case');
    } finally {
      await isolated.stop();
    }
  });

  test('rejects malformed input with the offending field named', async () => {
    const client = await visitor();
    const cases = [
      [{ name: '', email: 'a@b.com' }, 'name'],
      [{ name: '!!!', email: 'a@b.com' }, 'name'],
      [{ name: 'Valid', email: 'not-an-email' }, 'email'],
      [{ name: 'Valid', email: 'a@b' }, 'email'],
    ];
    for (const [body, field] of cases) {
      const response = await client.post('/api/v1/apps/pages/waitlist', body);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.equal(response.body.field, field);
    }
  });

  test('a malformed phone is reported for an app that does collect one', async () => {
    const isolated = await startTestServer();
    try {
      await makeApp(isolated, { slug: 'phoneapp', name: 'Phone App', collectPhone: true });
      const client = isolated.client();
      await client.unlockGate();
      for (const phone of ['123', 'abc-defg']) {
        const response = await client.post('/api/v1/apps/phoneapp/waitlist', {
          name: 'Valid',
          email: `v-${phone}@example.com`,
          phone,
        });
        assert.equal(response.status, 400, `expected 400 for phone ${phone}`);
        assert.equal(response.body.field, 'phone');
      }
    } finally {
      await isolated.stop();
    }
  });

  test('phone is optional', async () => {
    const client = await visitor();
    const response = await client.post('/api/v1/apps/pages/waitlist', {
      name: 'No Phone',
      email: `nophone-${Date.now()}@example.com`,
    });
    assert.equal(response.status, 201);
  });

  test('the honeypot answers like a success but stores nothing', async () => {
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      await client.unlockGate();
      const response = await client.post('/api/v1/apps/pages/waitlist', {
        name: 'Bot',
        email: 'bot@example.com',
        website: 'http://spam.example',
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true, 'a bot should not learn that it was caught');

      const adminClient = isolated.client();
      await adminClient.unlockGate();
      await adminClient.signInAdmin();
      const list = await adminClient.get('/api/v1/admin/entries');
      assert.equal(list.body.total, 0, 'nothing should have been stored');
    } finally {
      await isolated.stop();
    }
  });

  test('an unknown app is a 404', async () => {
    const client = await visitor();
    const response = await client.get('/api/v1/apps/does-not-exist/count');
    assert.equal(response.status, 404);
  });

  test('concurrent signups get unique, gap-free positions', async () => {
    // The signup limiter would (correctly) reject most of this burst, and
    // this test is about position allocation rather than throttling, so it
    // is lifted for this server alone.
    const isolated = await startTestServer({ RL_SIGNUP_MAX: '500' });
    try {
      const client = isolated.client();
      await client.unlockGate();

      const N = 40;
      const responses = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          client.post('/api/v1/apps/pages/waitlist', {
            name: `Racer ${i}`,
            email: `racer${i}@example.com`,
          }),
        ),
      );

      const positions = responses.map((r) => r.body.position).sort((a, b) => a - b);
      assert.equal(new Set(positions).size, N, 'every position must be unique');
      assert.deepEqual(positions, Array.from({ length: N }, (_, i) => i + 1), 'positions must be 1..N with no gaps');
    } finally {
      await isolated.stop();
    }
  });
});

describe('multi-tenancy', () => {
  test('each app numbers independently and may share an email', async () => {
    const isolated = await startTestServer();
    try {
      const adminClient = isolated.client();
      await adminClient.unlockGate();
      await adminClient.signInAdmin();
      const created = await adminClient.post('/api/v1/admin/apps', { slug: 'second', name: 'Second App' });
      assert.equal(created.status, 201);

      const client = isolated.client();
      await client.unlockGate();
      await client.post('/api/v1/apps/pages/waitlist', { name: 'Shared', email: 'shared@example.com' });
      await client.post('/api/v1/apps/pages/waitlist', { name: 'Other', email: 'other@example.com' });

      const onSecond = await client.post('/api/v1/apps/second/waitlist', { name: 'Shared', email: 'shared@example.com' });
      assert.equal(onSecond.status, 201, 'the same address may join a different app');
      assert.equal(onSecond.body.position, 1, 'the second app starts its own numbering');

      const pages = await client.get('/api/v1/apps/pages/count');
      const second = await client.get('/api/v1/apps/second/count');
      assert.equal(pages.body.count, 2);
      assert.equal(second.body.count, 1);
    } finally {
      await isolated.stop();
    }
  });

  test('a deactivated app stops accepting signups', async () => {
    const isolated = await startTestServer();
    try {
      const adminClient = isolated.client();
      await adminClient.unlockGate();
      await adminClient.signInAdmin();
      const apps = await adminClient.get('/api/v1/admin/apps');
      const pages = apps.body.apps.find((a) => a.slug === 'pages');
      await adminClient.patch(`/api/v1/admin/apps/${pages.id}`, { isActive: false });

      const client = isolated.client();
      await client.unlockGate();
      const response = await client.post('/api/v1/apps/pages/waitlist', { name: 'Late', email: 'late@example.com' });
      assert.equal(response.status, 404);
    } finally {
      await isolated.stop();
    }
  });
});

describe('admin management', () => {
  let isolated;
  let client;

  beforeEach(async () => {
    if (isolated) await isolated.stop();
    isolated = await startTestServer();
    client = isolated.client();
    await client.unlockGate();
    await client.signInAdmin();
    // Its own app, collecting a phone number, so these tests do not depend on
    // how the shipped Pages design happens to be configured this week.
    await client.post('/api/v1/admin/apps', { slug: 'people', name: 'People', collectPhone: true });
    for (let i = 0; i < 5; i += 1) {
      await client.post('/api/v1/apps/people/waitlist', {
        name: `Person ${i}`,
        email: `person${i}@example.com`,
        phone: i % 2 ? `010-0000-000${i}` : '',
      });
    }
  });

  after(async () => { if (isolated) await isolated.stop(); });

  test('lists, searches and paginates', async () => {
    const all = await client.get('/api/v1/admin/entries');
    assert.equal(all.body.total, 5);

    const searched = await client.get('/api/v1/admin/entries?search=person3');
    assert.equal(searched.body.total, 1);
    assert.equal(searched.body.entries[0].name, 'Person 3');

    const paged = await client.get('/api/v1/admin/entries?limit=2&offset=2');
    assert.equal(paged.body.entries.length, 2);
    assert.equal(paged.body.entries[0].position, 3);
  });

  test('search matches phone numbers regardless of formatting', async () => {
    const byPhone = await client.get('/api/v1/admin/entries?search=01000000001');
    assert.equal(byPhone.body.total, 1);
  });

  test('status changes are recorded and removed entries leave the public count', async () => {
    const list = await client.get('/api/v1/admin/entries');
    const target = list.body.entries[0];

    const updated = await client.patch(`/api/v1/admin/entries/${target.id}`, { status: 'invited', note: 'sent' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.entry.status, 'invited');
    assert.equal(updated.body.entry.note, 'sent');

    await client.patch(`/api/v1/admin/entries/${list.body.entries[1].id}`, { status: 'removed' });
    const count = await client.get('/api/v1/apps/people/count');
    assert.equal(count.body.count, 4, 'removed entries drop out of the public counter');

    const events = await client.get('/api/v1/admin/events?type=admin.entry_updated');
    assert.ok(events.body.total >= 2, 'each change should be in the activity trail');
  });

  test('deletion removes the row and leaves an audit record', async () => {
    const list = await client.get('/api/v1/admin/entries');
    const target = list.body.entries[4];

    const deleted = await client.delete(`/api/v1/admin/entries/${target.id}`);
    assert.equal(deleted.status, 200);

    const after = await client.get('/api/v1/admin/entries');
    assert.equal(after.body.total, 4);

    const events = await client.get('/api/v1/admin/events?type=admin.entry_deleted');
    assert.equal(events.body.total, 1);
    assert.equal(events.body.events[0].severity, 'warn');
  });

  test('overview totals agree with the entry list', async () => {
    const overview = await client.get('/api/v1/admin/overview');
    assert.equal(overview.body.totals.total, 5);
    assert.equal(overview.body.totals.withPhone, 2);
    // Found by slug, not by index: several apps exist and the list is ordered
    // by display name, so a positional assertion is brittle.
    const people = overview.body.apps.find((a) => a.slug === 'people');
    assert.ok(people, 'the app under test should appear in the overview');
    assert.equal(people.total, 5);
    assert.ok(Array.isArray(overview.body.signupsByDay));
  });

  test('exports every format, honouring the active filter', async () => {
    for (const format of ['csv', 'tsv', 'json', 'ndjson', 'xlsx']) {
      const response = await client.get(`/api/v1/admin/entries/export?format=${format}`);
      assert.equal(response.status, 200, `${format} export should succeed`);
      assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename=/);
      const payload = response.body;
      const nonEmpty = typeof payload === 'string' ? payload.length > 0 : Array.isArray(payload?.rows);
      assert.ok(nonEmpty, `${format} export should not be empty`);
      if (format === 'json') assert.equal(payload.rows.length, 5);
    }

    const csv = await client.get('/api/v1/admin/entries/export?format=csv&search=person1');
    const lines = String(csv.body).trim().split('\r\n');
    assert.equal(lines.length, 2, 'a filtered export is header plus one row');
    assert.match(lines[1], /Person 1/);
  });

  test('the meta option adds attribution columns', async () => {
    const plain = await client.get('/api/v1/admin/entries/export?format=csv');
    const meta = await client.get('/api/v1/admin/entries/export?format=csv&include=meta');
    assert.ok(!String(plain.body).includes('IP Pseudonym'));
    assert.ok(String(meta.body).includes('IP Pseudonym'));
    assert.ok(String(meta.body).includes('User Agent'));
  });

  test('a name that looks like a formula is neutralised in CSV', async () => {
    await client.post('/api/v1/apps/pages/waitlist', {
      name: '=HYPERLINK("http://evil","x")',
      email: 'formula@example.com',
    });
    const csv = await client.get('/api/v1/admin/entries/export?format=csv&search=HYPERLINK');
    assert.ok(String(csv.body).includes("'=HYPERLINK"), 'a leading = must be escaped to plain text');
  });

  test('the XLSX export is a readable workbook', async () => {
    const response = await fetch(`${isolated.base}/api/v1/admin/entries/export?format=xlsx`, {
      headers: { Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    const buffer = Buffer.from(await response.arrayBuffer());

    assert.equal(buffer.subarray(0, 2).toString(), 'PK', 'must be a ZIP container');

    // Walk the local file headers and inflate each part, which proves the
    // CRCs and sizes written by the hand-rolled ZIP writer are correct.
    let offset = 0;
    const parts = new Map();
    while (buffer.readUInt32LE(offset) === 0x04034b50) {
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const nameLength = buffer.readUInt16LE(offset + 26);
      const extraLength = buffer.readUInt16LE(offset + 28);
      const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
      const dataStart = offset + 30 + nameLength + extraLength;
      parts.set(name, zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize)).toString('utf8'));
      offset = dataStart + compressedSize;
    }

    assert.ok(parts.has('xl/worksheets/sheet1.xml'), 'workbook must contain a sheet');
    assert.ok(parts.has('[Content_Types].xml'));
    assert.match(parts.get('xl/worksheets/sheet1.xml'), /Person 0/);
  });

  test('an unsupported export format is refused', async () => {
    const response = await client.get('/api/v1/admin/entries/export?format=../../etc/passwd');
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'format_invalid');
  });
});

describe('activity trail', () => {
  test('records signups, admin actions and failures', async () => {
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      await client.unlockGate();
      await client.post('/api/v1/apps/pages/waitlist', { name: 'Logged', email: 'logged@example.com' });
      await client.post('/api/v1/apps/pages/waitlist', { name: '', email: 'bad@example.com' });

      const adminClient = isolated.client();
      await adminClient.unlockGate();
      await adminClient.post('/api/v1/admin/login', { password: 'wrong-password' });
      await adminClient.signInAdmin();

      const events = await adminClient.get('/api/v1/admin/events?limit=100');
      const types = new Set(events.body.events.map((e) => e.type));

      for (const expected of ['gate.login', 'signup.created', 'signup.rejected', 'admin.login_failed', 'admin.login']) {
        assert.ok(types.has(expected), `expected a "${expected}" event, saw: ${[...types].join(', ')}`);
      }

      const signup = events.body.events.find((e) => e.type === 'signup.created');
      assert.ok(signup.requestId, 'events carry the request id that produced them');
      assert.ok(signup.ipHash, 'events carry a pseudonymised client identity');
      assert.ok(!JSON.stringify(events.body).includes('127.0.0.1'), 'no raw IP address should be stored');
    } finally {
      await isolated.stop();
    }
  });

  test('exports the activity trail', async () => {
    const response = await admin.get('/api/v1/admin/events/export?format=csv');
    assert.equal(response.status, 200);
    assert.match(String(response.body), /Timestamp \(UTC\)/);
  });
});

describe('health', () => {
  test('liveness and readiness answer without a session', async () => {
    const client = server.client();
    const alive = await client.get('/healthz');
    assert.equal(alive.status, 200);
    assert.equal(alive.body.status, 'alive');

    const ready = await client.get('/readyz');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, 'ready');
  });
});

describe('per-app fields', () => {
  test('an email-only app accepts a signup with no name', async () => {
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      await client.unlockGate();

      const response = await client.post('/api/v1/apps/cdots/waitlist', { email: 'noname@example.com' });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.position, 1);

      const adminClient = isolated.client();
      await adminClient.unlockGate();
      await adminClient.signInAdmin();
      const list = await adminClient.get('/api/v1/admin/entries?search=noname');
      assert.equal(list.body.total, 1);
      assert.equal(list.body.entries[0].name, '', 'the stored name should be empty, not a placeholder');
    } finally {
      await isolated.stop();
    }
  });

  test('an app that requires a name still rejects a signup without one', async () => {
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      await client.unlockGate();
      const response = await client.post('/api/v1/apps/pages/waitlist', { email: 'anon@example.com' });
      assert.equal(response.status, 400);
      assert.equal(response.body.field, 'name');
    } finally {
      await isolated.stop();
    }
  });

  test('a name sent to an email-only app is discarded rather than stored', async () => {
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      await client.unlockGate();
      await client.post('/api/v1/apps/cdots/waitlist', { email: 'ignored@example.com', name: 'Should Not Persist' });

      const adminClient = isolated.client();
      await adminClient.unlockGate();
      await adminClient.signInAdmin();
      const list = await adminClient.get('/api/v1/admin/entries?search=ignored');
      assert.equal(list.body.entries[0].name, '', 'an app that does not collect names must not store one');
    } finally {
      await isolated.stop();
    }
  });

  test('capacity is reported as places remaining, and counts down', async () => {
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      await client.unlockGate();

      const before = await client.get('/api/v1/apps/cdots/count');
      assert.equal(before.body.capacity, 100);
      assert.equal(before.body.remaining, 100);

      await client.post('/api/v1/apps/cdots/waitlist', { email: 'first@example.com' });
      const after = await client.get('/api/v1/apps/cdots/count');
      assert.equal(after.body.count, 1);
      assert.equal(after.body.remaining, 99, 'one signup should consume one place');

      const meta = await client.get('/api/v1/apps/cdots');
      assert.equal(meta.body.app.collectName, false);
      assert.equal(meta.body.app.remaining, 99);
    } finally {
      await isolated.stop();
    }
  });

  test('an app with no capacity reports remaining as null, never a negative', async () => {
    const isolated = await startTestServer();
    try {
      // Created without a capacity, which is the default and means "no limit".
      await makeApp(isolated, { slug: 'unlimited', name: 'Unlimited' });
      const client = isolated.client();
      await client.unlockGate();
      const response = await client.get('/api/v1/apps/unlimited/count');
      assert.equal(response.body.capacity, 0);
      assert.equal(response.body.remaining, null);
    } finally {
      await isolated.stop();
    }
  });

  test('remaining floors at zero when capacity is lowered below the signups already taken', async () => {
    const isolated = await startTestServer({ RL_SIGNUP_MAX: '500' });
    try {
      const adminClient = isolated.client();
      await adminClient.unlockGate();
      await adminClient.signInAdmin();
      const apps = await adminClient.get('/api/v1/admin/apps');
      const cdots = apps.body.apps.find((a) => a.slug === 'cdots');
      assert.equal(cdots.capacity, 100);

      const client = isolated.client();
      await client.unlockGate();
      for (let i = 0; i < 3; i += 1) {
        await client.post('/api/v1/apps/cdots/waitlist', { email: `over${i}@example.com` });
      }

      // Signing up can no longer exceed the limit, so the only way to end up
      // over it is an administrator reducing it afterwards. The arithmetic
      // must still report no places left rather than a negative number.
      await adminClient.patch(`/api/v1/admin/apps/${cdots.id}`, { capacity: 2 });

      const response = await client.get('/api/v1/apps/cdots/count');
      assert.equal(response.body.count, 3);
      assert.equal(response.body.remaining, 0, 'must floor at zero rather than go negative');
    } finally {
      await isolated.stop();
    }
  });
});

describe('data minimisation', () => {
  test('an app that does not collect phones refuses to store one that is posted', async () => {
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      await client.unlockGate();
      // Pages collects a name but not a phone number.
      await client.post('/api/v1/apps/pages/waitlist', {
        name: 'Phone Sender',
        email: 'phonesender@example.com',
        phone: '010-9999-8888',
      });

      const adminClient = isolated.client();
      await adminClient.unlockGate();
      await adminClient.signInAdmin();
      const list = await adminClient.get('/api/v1/admin/entries?search=phonesender');
      assert.equal(list.body.entries[0].phone, '', 'a phone must not be stored by an app that does not collect one');
      assert.equal(list.body.entries[0].name, 'Phone Sender', 'the name it does collect is kept');
    } finally {
      await isolated.stop();
    }
  });

  test('an invalid phone is not even an error when the app does not collect phones', async () => {
    const isolated = await startTestServer();
    try {
      const client = isolated.client();
      await client.unlockGate();
      const response = await client.post('/api/v1/apps/pages/waitlist', {
        name: 'Junk Phone',
        email: 'junkphone@example.com',
        phone: 'not a phone number at all',
      });
      assert.equal(response.status, 201, 'an ignored field should not fail the signup');
    } finally {
      await isolated.stop();
    }
  });
});

describe('capacity enforcement', () => {
  test('a full app refuses new signups but still recognises existing ones', async () => {
    const isolated = await startTestServer({ RL_SIGNUP_MAX: '500' });
    try {
      const client = isolated.client();
      await client.unlockGate();

      const adminClient = isolated.client();
      await adminClient.unlockGate();
      await adminClient.signInAdmin();
      const apps = await adminClient.get('/api/v1/admin/apps');
      const pages = apps.body.apps.find((a) => a.slug === 'pages');
      await adminClient.patch(`/api/v1/admin/apps/${pages.id}`, { capacity: 3 });

      for (let i = 0; i < 3; i += 1) {
        const r = await client.post('/api/v1/apps/pages/waitlist', {
          name: `Filler ${i}`,
          email: `filler${i}@example.com`,
        });
        assert.equal(r.status, 201, `signup ${i} should fit`);
      }

      const overflow = await client.post('/api/v1/apps/pages/waitlist', {
        name: 'Too Late',
        email: 'toolate@example.com',
      });
      assert.equal(overflow.status, 409);
      assert.equal(overflow.body.error, 'full', 'the landing page keys off this exact code');
      assert.equal(overflow.body.remaining, 0);

      // Already on the list: they hold a place, so they are not turned away.
      const returning = await client.post('/api/v1/apps/pages/waitlist', {
        name: 'Filler 0',
        email: 'filler0@example.com',
      });
      assert.equal(returning.status, 200);
      assert.equal(returning.body.duplicate, true);
      assert.equal(returning.body.position, 1);
    } finally {
      await isolated.stop();
    }
  });

  test('a simultaneous rush cannot push an app past its capacity', async () => {
    const isolated = await startTestServer({ RL_SIGNUP_MAX: '500' });
    try {
      const adminClient = isolated.client();
      await adminClient.unlockGate();
      await adminClient.signInAdmin();
      const apps = await adminClient.get('/api/v1/admin/apps');
      const cdots = apps.body.apps.find((a) => a.slug === 'cdots');
      await adminClient.patch(`/api/v1/admin/apps/${cdots.id}`, { capacity: 10 });

      const client = isolated.client();
      await client.unlockGate();

      // Thirty people going for ten places at the same instant. A capacity
      // check made outside the insert lock would let several through.
      const responses = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          client.post('/api/v1/apps/cdots/waitlist', { email: `rush${i}@example.com` }),
        ),
      );
      const accepted = responses.filter((r) => r.status === 201);
      const refused = responses.filter((r) => r.body?.error === 'full');

      assert.equal(accepted.length, 10, 'exactly the capacity should be admitted');
      assert.equal(refused.length, 20, 'everyone else should be told it is full');

      const count = await client.get('/api/v1/apps/cdots/count');
      assert.equal(count.body.count, 10, 'the stored count must never exceed capacity');
      assert.equal(count.body.remaining, 0);
    } finally {
      await isolated.stop();
    }
  });
});

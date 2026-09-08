/**
 * Concurrency check.
 *
 * Simulates N independent devices holding their own gate session and issuing
 * a realistic mix of traffic -- loading the landing page, polling the counter,
 * occasionally signing up -- for a fixed duration, then reports latency
 * percentiles, throughput and errors per endpoint.
 *
 * The question it answers is the one that matters operationally: with more
 * than ten devices on the page at once, does anything queue up or stall?
 *
 * Usage:
 *   node scripts/loadtest.mjs [--base http://127.0.0.1:8099]
 *                             [--devices 25] [--seconds 20]
 *                             [--gate-password ...]
 */
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const BASE = args.get('base') ?? 'http://127.0.0.1:8099';
const DEVICES = Number(args.get('devices') ?? 25);
const SECONDS = Number(args.get('seconds') ?? 20);
// Never defaulted to a literal: a password baked into a committed script is
// a password published to everyone who can read the repository.
const GATE_PASSWORD = args.get('gate-password') ?? process.env.SITE_GATE_PASSWORD;
const APP = args.get('app') ?? 'pages';

if (!GATE_PASSWORD) {
  console.error('Pass --gate-password, or set SITE_GATE_PASSWORD in the environment.');
  process.exit(2);
}

/** Per-endpoint latency samples and outcome counters. */
const stats = new Map();

function record(label, ms, status) {
  let bucket = stats.get(label);
  if (!bucket) {
    bucket = { samples: [], ok: 0, rateLimited: 0, failed: 0 };
    stats.set(label, bucket);
  }
  bucket.samples.push(ms);
  if (status === 429) bucket.rateLimited += 1;
  else if (status >= 200 && status < 400) bucket.ok += 1;
  else bucket.failed += 1;
}

async function timed(label, fn) {
  const started = performance.now();
  try {
    const status = await fn();
    record(label, performance.now() - started, status);
    return status;
  } catch (err) {
    record(label, performance.now() - started, 0);
    return 0;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

/** One virtual device: unlocks the gate once, then loops until told to stop. */
async function device(id, deadline) {
  // Each device gets its own cookie jar, exactly like a separate browser.
  const login = await fetch(`${BASE}/api/v1/gate/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ password: GATE_PASSWORD }),
  });
  if (!login.ok) throw new Error(`device ${id}: gate login failed with ${login.status}`);
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');

  let signups = 0;

  while (performance.now() < deadline) {
    // Load the landing page, as a browser would on arrival or refresh.
    await timed('GET /a/<app>/ (landing page)', async () => {
      const response = await fetch(`${BASE}/a/${APP}/`, { headers: { Cookie: cookie } });
      await response.arrayBuffer();
      return response.status;
    });

    // Poll the counter a few times, as visitors sitting on the page do.
    for (let i = 0; i < 3; i += 1) {
      await timed('GET /count (counter poll)', async () => {
        const response = await fetch(`${BASE}/api/v1/apps/${APP}/count`, { headers: { Cookie: cookie } });
        await response.json().catch(() => null);
        return response.status;
      });
    }

    // A minority of devices actually sign up, which is the write path.
    if (signups < 2 && id % 3 === 0) {
      signups += 1;
      await timed('POST /waitlist (signup)', async () => {
        const response = await fetch(`${BASE}/api/v1/apps/${APP}/waitlist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: BASE },
          body: JSON.stringify({
            name: `Load Tester ${id}-${signups}`,
            email: `load-${id}-${signups}-${Date.now()}@example.com`,
            phone: `010-${String(1000 + id).slice(0, 4)}-${String(1000 + signups).slice(0, 4)}`,
            source: 'loadtest',
          }),
        });
        await response.json().catch(() => null);
        return response.status;
      });
    }
  }
}

console.log(`Load test → ${BASE}`);
console.log(`${DEVICES} concurrent devices for ${SECONDS}s on app "${APP}"\n`);

const wallStart = performance.now();
const deadline = wallStart + SECONDS * 1000;
const results = await Promise.allSettled(Array.from({ length: DEVICES }, (_, i) => device(i, deadline)));
const wallMs = performance.now() - wallStart;

const crashed = results.filter((r) => r.status === 'rejected');
if (crashed.length) {
  console.log(`${crashed.length} device(s) failed to start:`);
  crashed.slice(0, 3).forEach((r) => console.log(`  ${r.reason?.message}`));
  console.log('');
}

let totalRequests = 0;
let totalFailed = 0;
let worstP99 = 0;

const rows = [];
for (const [label, bucket] of stats) {
  const sorted = bucket.samples.slice().sort((a, b) => a - b);
  totalRequests += sorted.length;
  totalFailed += bucket.failed;
  worstP99 = Math.max(worstP99, percentile(sorted, 99));
  rows.push({
    Endpoint: label,
    Requests: sorted.length,
    OK: bucket.ok,
    '429': bucket.rateLimited,
    Failed: bucket.failed,
    'p50 ms': percentile(sorted, 50).toFixed(1),
    'p95 ms': percentile(sorted, 95).toFixed(1),
    'p99 ms': percentile(sorted, 99).toFixed(1),
    'max ms': sorted.length ? sorted[sorted.length - 1].toFixed(1) : '0',
  });
}

console.table(rows);

const rps = totalRequests / (wallMs / 1000);
console.log(`\nTotal requests   ${totalRequests}`);
console.log(`Throughput       ${rps.toFixed(0)} req/s sustained`);
console.log(`Hard failures    ${totalFailed}`);
console.log(`Worst p99        ${worstP99.toFixed(1)} ms`);

// A hang is what this test exists to detect: a p99 in the seconds, or any
// request that never got an answer at all.
const HANG_THRESHOLD_MS = 1000;
const healthy = totalFailed === 0 && worstP99 < HANG_THRESHOLD_MS;
console.log(`\n${healthy ? 'PASS' : 'FAIL'} — ${
  healthy
    ? `no failures and p99 under ${HANG_THRESHOLD_MS}ms; the service stayed responsive`
    : 'see failures or slow percentiles above'
}`);
process.exit(healthy ? 0 : 1);

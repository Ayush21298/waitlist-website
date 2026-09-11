/**
 * Browser test: drives the real UI in Chromium, the way a person would.
 *
 * The HTTP tests prove the API is correct. This proves the pages are actually
 * wired to it -- that the gate form submits, the landing page counter reads
 * from the backend, a signup updates the page, and the admin panel renders
 * live data rather than an empty table. Those are integration failures that
 * an API test cannot see, because the API is fine in every one of them.
 *
 * Also captures screenshots so the layout can be looked at, and fails on any
 * console error or failed network request the pages produce along the way.
 *
 * Usage:
 *   node scripts/ui-test.mjs --base http://127.0.0.1:8099 \
 *        --gate-password ... --admin-password ... [--shots ./screenshots]
 */
import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const BASE = (args.get('base') ?? 'http://127.0.0.1:8099').replace(/\/$/, '');
const GATE_PASSWORD = args.get('gate-password') ?? process.env.SITE_GATE_PASSWORD;
const ADMIN_PASSWORD = args.get('admin-password') ?? process.env.ADMIN_PASSWORD;
const SHOTS = args.get('shots') ?? null;
const APP = args.get('app') ?? 'pages';

if (!GATE_PASSWORD || !ADMIN_PASSWORD) {
  console.error('Pass --gate-password and --admin-password (or set them in the environment).');
  process.exit(2);
}
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let passed = 0;
let failed = 0;
const pageErrors = [];
const consoleErrors = [];
const failedRequests = [];

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function shot(page, name) {
  if (!SHOTS) return;
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`        saved ${file}`);
}

/**
 * Optional --resolve host:ip, passed through to Chromium's own resolver.
 *
 * Lets the suite run against a public tunnel URL from a machine whose local
 * DNS cannot resolve it, so the real HTTPS path -- proxy headers, Secure
 * cookies, HSTS -- is exercised rather than only localhost.
 */
const RESOLVE = args.get('resolve');
const launchArgs = RESOLVE
  ? [`--host-resolver-rules=MAP ${RESOLVE.split(':')[0]} ${RESOLVE.split(':')[1]}`, '--ignore-certificate-errors']
  : [];

const browser = await chromium.launch({ args: launchArgs });
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await context.newPage();

// An uncaught exception in page script. This is the signal that matters:
// it means the page is broken, not merely that a request was refused.
page.on('pageerror', (error) => pageErrors.push(error.message));

page.on('console', (message) => {
  if (message.type() !== 'error') return;
  // Chromium logs every non-2xx response as a console error. Several 401s
  // are part of the flow being tested on purpose -- the panel probing for an
  // existing session, the deliberate wrong-password attempts, the state after
  // signing out -- so they are not evidence of a defect.
  if (/Failed to load resource.*\b(401|403|429)\b/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('requestfailed', (request) => {
  // Webfonts come from a CDN and may be blocked in a sandbox; that is not a
  // failure of this application.
  if (!request.url().startsWith(BASE)) return;
  failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText}`);
});

const stamp = Date.now();
const testEmail = `ui-test-${stamp}@example.com`;
const testName = `UI 테스트 ${stamp}`;

try {
  /* ---------------- the gate ---------------- */
  console.log('\nSite gate');
  await page.goto(`${BASE}/a/${APP}/`, { waitUntil: 'domcontentloaded' });
  check('an unauthenticated visit lands on the gate', page.url().includes('/gate'), page.url());
  check('the gate explains itself', (await page.locator('h1').innerText()).length > 0);
  await shot(page, '01-gate');

  await page.fill('#password', 'definitely-wrong');
  await page.click('#submit');
  await page.waitForSelector('#error.show', { timeout: 5000 });
  check('a wrong password shows an error', await page.locator('#error').isVisible());
  check('the error is human-readable', (await page.locator('#error').innerText()).trim().length > 5);
  await shot(page, '02-gate-error');

  await page.fill('#password', GATE_PASSWORD);
  await page.click('#submit');
  await page.waitForURL(`**/a/${APP}/**`, { timeout: 15000 });
  check('the correct password returns you to where you were going', page.url().includes(`/a/${APP}/`));

  // A deep link is honoured above; arriving at the root lands on the index.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  check('the root is reachable once unlocked', new URL(page.url()).pathname === '/');

  /* ---------------- the front door ---------------- */
  console.log('\nApp index');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.querySelectorAll('.app:not(.skeleton)').length > 0,
    null,
    { timeout: 15000 },
  );

  const indexCards = await page.locator('.app').count();
  check('the root lists the apps rather than jumping into one', indexCards >= 2, `${indexCards} cards`);
  check('each card links to its own app',
    (await page.locator('.app[href="/a/pages/"]').count()) === 1
    && (await page.locator('.app[href="/a/cdots/"]').count()) === 1);
  check('a card shows a live figure, not a placeholder',
    /\d/.test(await page.locator('.app .stat .n').first().innerText()));
  await shot(page, '00-home');

  // Both cards must actually go somewhere.
  await page.click('.app[href="/a/cdots/"]');
  await page.waitForURL('**/a/cdots/**', { timeout: 15000 });
  check('clicking the C-Dots card opens C-Dots', page.url().includes('/a/cdots/'));

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.querySelectorAll('.app:not(.skeleton)').length > 0,
    null,
    { timeout: 15000 },
  );
  await page.click('.app[href="/a/pages/"]');
  await page.waitForURL('**/a/pages/**', { timeout: 15000 });
  check('clicking the Pages card opens Pages', page.url().includes('/a/pages/'));

  /* ---------------- the landing page ---------------- */
  console.log('\nLanding page');
  await page.waitForLoadState('networkidle');

  const counter = page.locator('#count');
  await page.waitForFunction(() => {
    const el = document.querySelector('#count');
    return el && el.textContent.trim() !== '' && el.textContent.trim() !== '—';
  }, { timeout: 15000 }).catch(() => {});
  const counterText = (await counter.innerText()).trim();
  check('the counter loaded a number from the backend', /^[\d,]+$/.test(counterText), `showed "${counterText}"`);
  check('the counter is no longer in its loading state',
    !(await page.locator('#counter').getAttribute('class') ?? '').includes('loading'));

  check('the form asks for a name and an email only', (await page.locator('#phone').count()) === 0);
  const capacityLabel = (await page.locator('.counter .big small').innerText()).trim();
  check('the capacity comes from the backend', /^\/\s*\d+$/.test(capacityLabel), capacityLabel);
  check('the format gallery rendered', (await page.locator('.slot').count()) > 0,
    `${await page.locator('.slot').count()} cards`);
  await shot(page, '03-landing');

  // Client-side validation must fire before anything is sent.
  await page.fill('#name', 'Valid Name');
  await page.fill('#email', 'not-an-email');
  await page.click('#btn');
  check('an invalid email is caught in the browser', await page.locator('#f-email.bad').count() > 0);



  /* ---------------- signup ---------------- */
  console.log('\nSignup through the form');
  await page.fill('#name', testName);
  await page.fill('#email', testEmail);
  await page.click('#btn');

  await page.waitForSelector('#join[data-state="done"]', { timeout: 15000 });
  check('the card switches to its confirmation state', true);

  const position = (await page.locator('#myno').innerText()).trim();
  check('a waitlist position is shown', /^[\d,]+$/.test(position), `showed "${position}"`);
  check('the confirmation echoes the name', (await page.locator('#done-name').innerText()).includes(String(stamp)));
  check('the confirmation echoes the email', (await page.locator('#done-email').innerText()) === testEmail);

  // The confirmation fades in over 500ms; capturing mid-animation makes the
  // screenshot look washed out and misrepresents the design.
  await page.waitForTimeout(800);
  await shot(page, '04-signup-done');

  // The counter should have moved to include this signup.
  const afterCount = Number((await counter.innerText()).replace(/,/g, ''));
  check('the counter includes the new signup', afterCount >= Number(position.replace(/,/g, '')),
    `counter ${afterCount}, position ${position}`);

  /* ---------------- duplicate ---------------- */
  console.log('\nRepeat signup');
  await page.reload({ waitUntil: 'networkidle' });
  await page.fill('#name', 'Someone Else');
  await page.fill('#email', testEmail);
  await page.click('#btn');
  await page.waitForSelector('#join[data-state="done"]', { timeout: 15000 });
  const repeatPosition = (await page.locator('#myno').innerText()).trim();
  check('a repeat signup shows the original position, not an error', repeatPosition === position,
    `first ${position}, repeat ${repeatPosition}`);

  /* ---------------- admin ---------------- */
  console.log('\nAdmin panel');
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  check('the admin login screen is shown', await page.locator('#view-login').isVisible());
  await shot(page, '05-admin-login');

  await page.fill('#admin-password', GATE_PASSWORD);
  await page.click('#login-btn');
  await page.waitForSelector('#login-error.show', { timeout: 8000 });
  check('the gate password is refused by the admin panel', await page.locator('#login-error').isVisible());

  await page.fill('#admin-password', ADMIN_PASSWORD);
  await page.click('#login-btn');
  await page.waitForSelector('#view-app:not([hidden])', { timeout: 15000 });
  check('the admin password opens the panel', await page.locator('#view-app').isVisible());

  await page.waitForFunction(() => document.querySelectorAll('#tiles .tile').length > 0, { timeout: 15000 });
  const tiles = await page.locator('#tiles .tile .v').allInnerTexts();
  check('the overview tiles rendered with data', tiles.length === 4 && tiles.every((t) => t.trim().length > 0),
    tiles.join(' / '));
  check('the total is at least 1 after our signup', Number(tiles[0].replace(/,/g, '')) >= 1, tiles[0]);

  const chartPresent = (await page.locator('#chart-wrap svg').count()) > 0
    || (await page.locator('#chart-wrap .chart-empty').count()) > 0;
  check('the chart area rendered', chartPresent);
  check('the per-app breakdown has rows', (await page.locator('#apps-stats tbody tr').count()) > 0);
  await shot(page, '06-admin-overview');

  /* ---------------- the waitlist table ---------------- */
  console.log('\nAdmin — waitlist');
  await page.click('.tab[data-tab="entries"]');
  await page.waitForFunction(() => document.querySelectorAll('#entries-table tbody tr').length > 0, { timeout: 15000 });
  check('the entries table has rows', (await page.locator('#entries-table tbody tr').count()) > 0);

  await page.fill('#entry-search', testEmail);
  await page.waitForFunction(
    (email) => {
      const rows = document.querySelectorAll('#entries-table tbody tr');
      return rows.length === 1 && rows[0].textContent.includes(email);
    },
    testEmail,
    { timeout: 15000 },
  );
  const row = page.locator('#entries-table tbody tr').first();
  const rowText = await row.innerText();
  check('search finds the signup made through the form', rowText.includes(testEmail));
  check('the name typed in the browser is stored and shown', rowText.includes(String(stamp)));
  check('an app that collects no phone shows a placeholder, not a blank cell',
    rowText.includes('\u2014'), rowText.replace(/\s+/g, ' ').slice(0, 120));
  await shot(page, '07-admin-entries');

  // Change the status through the UI and confirm it sticks across a reload.
  await row.locator('select.status-select').selectOption('invited');
  await page.waitForSelector('.toast', { timeout: 10000 });
  check('changing a status shows a confirmation', (await page.locator('.toast').count()) > 0);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#view-app:not([hidden])', { timeout: 15000 });
  check('the admin session survives a reload', await page.locator('#view-app').isVisible());
  await page.click('.tab[data-tab="entries"]');
  await page.fill('#entry-search', testEmail);
  await page.waitForFunction(
    () => document.querySelectorAll('#entries-table tbody tr').length === 1,
    null,
    { timeout: 15000 },
  );
  const statusAfter = await page.locator('#entries-table tbody tr select.status-select').first().inputValue();
  check('the status change persisted to the database', statusAfter === 'invited', `saw "${statusAfter}"`);

  /* ---------------- activity log ---------------- */
  console.log('\nAdmin — activity log');
  await page.click('.tab[data-tab="activity"]');
  await page.waitForFunction(() => document.querySelectorAll('#events-table tbody tr').length > 0, { timeout: 15000 });
  const eventRows = await page.locator('#events-table tbody').innerText();
  check('the activity log has entries', (await page.locator('#events-table tbody tr').count()) > 0);
  check('it recorded the signup', eventRows.includes('signup.created'));
  check('it recorded the admin sign-in', eventRows.includes('admin.login'));
  await shot(page, '08-admin-activity');

  /* ---------------- export ---------------- */
  console.log('\nAdmin — export');
  await page.click('.tab[data-tab="entries"]');
  await page.waitForTimeout(500);
  await page.click('#export-entries-btn');
  check('the export menu opens', await page.locator('#export-entries-menu.open').isVisible());
  await shot(page, '09-admin-export-menu');

  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.click('#export-entries-menu button[data-format="csv"]'),
  ]).then(([d]) => d);
  const suggested = download.suggestedFilename();
  check('a CSV download starts', suggested.endsWith('.csv'), suggested);
  const downloadPath = await download.path();
  const csv = fs.readFileSync(downloadPath, 'utf8');
  check('the downloaded CSV contains the signup', csv.includes(testEmail));
  check('the CSV carries a UTF-8 BOM so Excel reads Korean correctly', csv.charCodeAt(0) === 0xfeff);

  /* ---------------- logout ---------------- */
  console.log('\nSign out');
  await page.click('#logout-btn');
  await page.waitForSelector('#view-login:not([hidden])', { timeout: 15000 });
  check('signing out returns to the login screen', await page.locator('#view-login').isVisible());

  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  check('the panel stays closed after signing out', await page.locator('#view-login').isVisible());

  /* ---------------- the second app ---------------- */
  // C-Dots is the proof that the platform is genuinely multi-tenant: a
  // completely different design, an email-only form, and a counter that
  // counts places down rather than signups up -- all on the same backend.
  console.log('\nSecond app (C-Dots)');
  await page.goto(`${BASE}/a/cdots/`, { waitUntil: 'networkidle' });

  const inputCount = await page.locator('input').count();
  check('the form asks for an email address and nothing else', inputCount === 1, `${inputCount} inputs`);
  check('no name field was added', (await page.locator('#name').count()) === 0);
  check('no phone field was added', (await page.locator('#phone').count()) === 0);

  await page.waitForFunction(
    () => {
      const el = document.querySelector('#remaining');
      return el && /^\d+$/.test(el.textContent.trim());
    },
    null,
    { timeout: 15000 },
  );
  const remainingBefore = Number((await page.locator('#remaining').innerText()).trim());
  const cdotsCapacityLabel = (await page.locator('.counter .total').innerText()).trim();
  check('the counter loaded places remaining from the backend', remainingBefore > 0, String(remainingBefore));
  check('the capacity comes from the backend too', cdotsCapacityLabel === '/100', cdotsCapacityLabel);

  // An invalid address must shake rather than submit.
  await page.fill('#email', 'not-an-email');
  await page.click('#go');
  await page.waitForTimeout(250);
  check('an invalid address is refused in the browser', (await page.locator('#wl.error').count()) > 0);

  const cdotsEmail = `cdots-ui-${stamp}@example.com`;
  await page.fill('#email', cdotsEmail);
  await page.click('#go');

  await page.waitForSelector('#wl.done', { timeout: 15000 });
  check('a valid address is accepted', true);

  await page.waitForFunction(
    (before) => Number(document.querySelector('#remaining').textContent.trim()) === before - 1,
    remainingBefore,
    { timeout: 15000 },
  ).catch(() => {});
  const remainingAfter = Number((await page.locator('#remaining').innerText()).trim());
  check('one signup consumes one place', remainingAfter === remainingBefore - 1,
    `${remainingBefore} -> ${remainingAfter}`);

  await page.waitForTimeout(1200);
  await shot(page, '11-cdots-success');

  // The page resets itself, and the signup must be in the shared admin panel.
  const cdotsAdmin = await context.newPage();
  await cdotsAdmin.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await cdotsAdmin.fill('#admin-password', ADMIN_PASSWORD);
  await cdotsAdmin.click('#login-btn');
  await cdotsAdmin.waitForSelector('#view-app:not([hidden])', { timeout: 15000 });
  await cdotsAdmin.click('.tab[data-tab="entries"]');
  await cdotsAdmin.fill('#entry-search', cdotsEmail);
  await cdotsAdmin.waitForFunction(
    () => document.querySelectorAll('#entries-table tbody tr').length === 1,
    null,
    { timeout: 15000 },
  );
  const cdotsRow = await cdotsAdmin.locator('#entries-table tbody tr').first().innerText();
  check('the C-Dots signup reaches the shared admin panel', cdotsRow.includes(cdotsEmail));
  check('it is attributed to the right app', cdotsRow.includes('Dots'), cdotsRow.replace(/\s+/g, ' ').slice(0, 90));
  await shot(cdotsAdmin, '12-admin-two-apps');
  await cdotsAdmin.close();

  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });

  /* ---------------- page hygiene ---------------- */
  console.log('\nPage hygiene');
  check('no uncaught JavaScript exceptions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('no unexpected console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check('no failed requests to this server', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));

  /* ---------------- mobile ---------------- */
  console.log('\nMobile viewport (390x844)');
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${BASE}/gate`, { waitUntil: 'networkidle' });
  await mobilePage.fill('#password', GATE_PASSWORD);
  await mobilePage.click('#submit');
  await mobilePage.waitForURL('**/a/**', { timeout: 15000 }).catch(() => {});
  await mobilePage.goto(`${BASE}/a/${APP}/`, { waitUntil: 'networkidle' });

  const overflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('the landing page does not scroll sideways on a phone', overflow <= 1, `${overflow}px of overflow`);
  if (SHOTS) {
    await mobilePage.screenshot({ path: path.join(SHOTS, '10-mobile-landing.png'), fullPage: false });
    console.log(`        saved ${path.join(SHOTS, '10-mobile-landing.png')}`);
  }

  await mobilePage.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  const adminOverflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('the admin login does not scroll sideways on a phone', adminOverflow <= 1, `${adminOverflow}px of overflow`);
  await mobilePage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await mobilePage.waitForFunction(
    () => document.querySelectorAll('.app:not(.skeleton)').length > 0,
    null,
    { timeout: 15000 },
  ).catch(() => {});
  const indexOverflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('the app index does not scroll sideways on a phone', indexOverflow <= 1, `${indexOverflow}px`);
  if (SHOTS) await mobilePage.screenshot({ path: path.join(SHOTS, '22-home-mobile.png'), fullPage: true });

  await mobile.close();

  /* ---------------- the closed state ---------------- */
  // Left until last, because it lowers a capacity and nothing after it should
  // depend on the app still accepting signups.
  console.log('\nRecruitment closed (Pages at capacity)');
  const closer = await context.newPage();
  await closer.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  // The admin session may already be live from an earlier section; the panel
  // decides which of its two views to show, so sign in only when asked to.
  if (await closer.locator('#view-login:not([hidden])').count()) {
    await closer.fill('#admin-password', ADMIN_PASSWORD);
    await closer.click('#login-btn');
  }
  await closer.waitForSelector('#view-app:not([hidden])', { timeout: 15000 });

  // Driven through the real control rather than the API, because the point of
  // the feature is that an administrator can do this without a terminal.
  await closer.click('.tab[data-tab="apps"]');
  await closer.waitForFunction(
    () => document.querySelectorAll('#apps-table tbody tr').length > 0,
    null,
    { timeout: 15000 },
  );

  const taken = await closer.evaluate(async () => {
    const r = await fetch('/api/v1/apps/pages/count', { credentials: 'same-origin' });
    return (await r.json()).count;
  });

  const pagesRow = closer.locator('#apps-table tbody tr').filter({ hasText: 'pages' });
  const capacityInput = pagesRow.locator('input[type=number]');
  check('capacity is editable from the Apps tab', (await capacityInput.count()) === 1);

  await capacityInput.fill(String(Math.max(1, taken)));
  await capacityInput.press('Enter');
  await closer.waitForSelector('.toast', { timeout: 10000 });
  check('changing it is confirmed', (await closer.locator('.toast').count()) > 0);
  await closer.close();

  await page.goto(`${BASE}/a/pages/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const el = document.querySelector('#count');
    return el && el.textContent.trim() !== '' && el.textContent.trim() !== '\u2014';
  }, { timeout: 15000 });
  await page.waitForTimeout(1100); // the count-up animation has to settle first

  check('the submit button is disabled once the beta is full',
    await page.locator('#btn').isDisabled());
  check('the button says so in Korean',
    (await page.locator('#btn').innerText()).includes('\uB9C8\uAC10'),
    await page.locator('#btn').innerText());
  check('the fields are locked too', (await page.locator('#name').isDisabled())
    && (await page.locator('#email').isDisabled()));
  await shot(page, '13-pages-full');

  // Raising the limit must reopen it, and the page must show the new figure
  // on its next load without any code change.
  const reopener = await context.newPage();
  await reopener.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  if (await reopener.locator('#view-login:not([hidden])').count()) {
    await reopener.fill('#admin-password', ADMIN_PASSWORD);
    await reopener.click('#login-btn');
  }
  await reopener.waitForSelector('#view-app:not([hidden])', { timeout: 15000 });
  await reopener.click('.tab[data-tab="apps"]');
  await reopener.waitForFunction(
    () => document.querySelectorAll('#apps-table tbody tr').length > 0,
    null,
    { timeout: 15000 },
  );
  const reopenInput = reopener.locator('#apps-table tbody tr').filter({ hasText: 'pages' })
    .locator('input[type=number]');
  await reopenInput.fill('250');
  await reopenInput.press('Enter');
  await reopener.waitForSelector('.toast', { timeout: 10000 });
  await reopener.close();

  await page.goto(`${BASE}/a/pages/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => /\/\s*250/.test(document.querySelector('.counter .big small')?.textContent ?? ''),
    null,
    { timeout: 15000 },
  ).catch(() => {});
  const reopenedLabel = (await page.locator('.counter .big small').innerText()).trim();
  check('a refreshed landing page shows the new capacity',
    reopenedLabel.replace(/\s/g, '') === '/250', reopenedLabel);
  check('and the form is open again', (await page.locator('#btn').isDisabled()) === false);
} catch (err) {
  failed += 1;
  console.log(`\n  FAIL  the run threw: ${err.message}`);
  if (SHOTS) {
    await page.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {});
    console.log(`        saved ${path.join(SHOTS, 'failure.png')}`);
  }
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (SHOTS && !failed) console.log(`Screenshots in ${path.resolve(SHOTS)}`);
process.exit(failed ? 1 : 0);

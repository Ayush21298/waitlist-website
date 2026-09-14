/**
 * Adds (or removes) obviously-fake entries, for demos and for checking a
 * deployment end to end.
 *
 * Writes straight to the database rather than through the public API, because
 * the signup endpoint is rate limited to ten per hour per address -- correct
 * for a real form, unhelpful when seeding fifteen rows on purpose.
 *
 * Two things this is deliberate about:
 *
 *   - Every row is easy to find and easy to undo. The name and the email both
 *     say "test", and `--remove` deletes exactly what was added, so seed data
 *     cannot quietly become permanent.
 *   - Emails are plus-addressed (test+01@test.com). One email per app is a
 *     database constraint, so fifteen rows cannot share one address; plus
 *     addressing keeps the base address the one you asked for while still
 *     being unique, and real mail providers deliver it to the same inbox.
 *
 * Usage:
 *   npm run seed:test                       15 entries on pages
 *   npm run seed:test -- --app cdots -n 10
 *   npm run seed:test -- --remove           delete them again
 */
import { config } from '../backend/src/config.js';
import { createStore } from '../backend/src/db/index.js';
import { Logger } from '../backend/src/logger.js';

const args = new Map();
const flags = new Set();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('-')) continue;
  const key = token.replace(/^-+/, '');
  const next = process.argv[i + 1];
  if (next && !next.startsWith('-')) {
    args.set(key, next);
    i += 1;
  } else {
    flags.add(key);
  }
}

const APP_SLUG = args.get('app') ?? 'pages';
const COUNT = Math.min(500, Math.max(1, Number(args.get('n') ?? args.get('count') ?? 15)));
const REMOVE = flags.has('remove');

/** The marker every seeded row carries, and the only thing --remove matches. */
const EMAIL_LOCAL = 'test';
const EMAIL_DOMAIN = 'test.com';
const NAME = 'test';

const logger = new Logger({ level: 'error', sinks: [] });
const { adapter, store } = await createStore(config, logger);

try {
  const app = await store.getAppBySlug(APP_SLUG);
  if (!app) {
    console.error(`No app with slug "${APP_SLUG}". Known apps: ${(await store.listApps()).map((a) => a.slug).join(', ')}`);
    process.exit(1);
  }

  const target = config.db.url ? 'the configured DATABASE_URL' : config.db.sqlitePath;
  console.log(`\n${REMOVE ? 'Removing' : 'Adding'} test entries on "${app.name}" (${APP_SLUG})`);
  console.log(`  database: ${target}`);

  if (REMOVE) {
    // Matched on the email key, which is the normalised form, so this cannot
    // catch a real signup that merely happens to be named "test".
    const { rows } = await store.listEntries({ appId: app.id, limit: 1000 });
    const seeded = rows.filter((row) => /^test\+\d+@test\.com$/.test(row.email_key));

    if (!seeded.length) {
      console.log('  nothing to remove.\n');
    } else {
      for (const row of seeded) await store.deleteEntry(row.id);
      console.log(`  removed ${seeded.length} test entr${seeded.length === 1 ? 'y' : 'ies'}.`);

      const remaining = await store.countEntries(app.id);
      console.log(`  ${remaining} real signup(s) remain.\n`);
    }
  } else {
    const before = await store.countEntries(app.id);
    const capacity = Number(app.capacity) || 0;
    if (capacity > 0 && before + COUNT > capacity) {
      console.log(
        `\n  Note: ${app.name} offers ${capacity} places and ${before} are taken, so\n` +
          `  ${COUNT} test entries would fill it and turn real people away.\n` +
          '  Raise the capacity in the admin panel first, or seed fewer.\n',
      );
      process.exit(1);
    }

    let added = 0;
    let skipped = 0;
    for (let i = 1; i <= COUNT; i += 1) {
      const suffix = String(i).padStart(2, '0');
      const email = `${EMAIL_LOCAL}+${suffix}@${EMAIL_DOMAIN}`;
      try {
        await store.createEntry({
          appId: app.id,
          // The app decides whether a name is wanted at all; an app that
          // collects none must not be given one.
          name: Number(app.collect_name) === 1 ? `${NAME} ${suffix}` : '',
          email,
          emailKey: email,
          phone: '',
          phoneKey: '',
          source: 'seed-test-data',
          capacity: 0, // the capacity check above already covered this
        });
        added += 1;
      } catch (err) {
        if (err.code === 'duplicate_email') skipped += 1;
        else throw err;
      }
    }

    const after = await store.countEntries(app.id);
    console.log(`  added ${added}${skipped ? `, skipped ${skipped} already present` : ''}`);
    console.log(`  ${app.name} now shows ${after}${capacity ? ` of ${capacity}` : ''}.`);
    console.log('\n  These are test rows. Remove them before launch with:');
    console.log(`    npm run seed:test -- --app ${APP_SLUG} --remove\n`);
  }
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await adapter.close();
}

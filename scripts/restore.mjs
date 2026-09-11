/**
 * Restores a backup produced by backup.mjs.
 *
 * Deliberately cautious, because this is the one script whose failure mode is
 * losing the data it was meant to protect:
 *
 *   - It refuses to run against a database that already holds signups unless
 *     --force says otherwise, so a restore cannot silently overwrite live data.
 *   - It reports exactly what it is about to do and requires confirmation,
 *     unless --yes is given.
 *   - It restores inside a transaction, so a half-applied restore is not a
 *     state the database can end up in.
 *   - It refuses a backup whose schema is newer than this code understands.
 *
 * Usage:
 *   npm run restore -- --file backups/waitlist-2026-09-11_01-00-00.json
 *   npm run restore -- --file <path> --yes --force
 */
import fs from 'node:fs';
import readline from 'node:readline/promises';

import { config } from '../backend/src/config.js';
import { createStore } from '../backend/src/db/index.js';
import { Logger } from '../backend/src/logger.js';
import { buildMigrations } from '../backend/src/db/migrations.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const FILE = args.get('file');
const ASSUME_YES = process.argv.includes('--yes');
const FORCE = process.argv.includes('--force');

if (!FILE) {
  console.error('Pass --file <backup.json>. List them with: ls backups/');
  process.exit(2);
}

const logger = new Logger({ level: 'error', sinks: [] });
const backup = JSON.parse(fs.readFileSync(FILE, 'utf8'));

if (backup.format !== 'r2p-waitlist-backup') {
  console.error(`${FILE} is not a waitlist backup.`);
  process.exit(1);
}

const { adapter, store } = await createStore(config, logger);

try {
  const known = buildMigrations(adapter.dialect);
  const latest = Math.max(...known.map((m) => m.version));
  if (Number(backup.schemaVersion) > latest) {
    console.error(
      `This backup was taken at schema v${backup.schemaVersion}, but this code only knows v${latest}.\n` +
        'Restoring it could drop columns the backup relies on. Update the code first.',
    );
    process.exit(1);
  }

  const existing = await adapter.get('SELECT COUNT(*) AS total FROM entries');
  const existingCount = Number(existing?.total ?? 0);

  console.log(`\nRestoring ${FILE}`);
  console.log(`  taken        ${backup.takenAt}`);
  console.log(`  contains     ${backup.counts.entries} signups, ${backup.counts.apps} app(s), ${backup.counts.events} events`);
  console.log(`  schema       v${backup.schemaVersion} (this code: v${latest})`);
  console.log(`  restoring to ${adapter.dialect}${config.db.url ? ' (DATABASE_URL)' : ` (${config.db.sqlitePath})`}`);
  console.log(`  that database currently holds ${existingCount} signup(s)`);

  if (existingCount > 0 && !FORCE) {
    console.error(
      '\nRefusing to continue: the target already has data, and restoring would replace it.\n' +
        'Take a backup of the current state first, then re-run with --force.',
    );
    process.exit(1);
  }

  if (!ASSUME_YES) {
    if (!process.stdin.isTTY) {
      console.error('\nNo terminal to confirm on. Re-run with --yes if you are sure.');
      process.exit(1);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('\nReplace the contents of that database? [y/N] ');
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Nothing was changed.');
      process.exit(1);
    }
  }

  await adapter.transaction(async (tx) => {
    // Order matters: entries and events reference apps.
    await tx.run('DELETE FROM events');
    await tx.run('DELETE FROM entries');
    await tx.run('DELETE FROM apps');

    for (const app of backup.apps) {
      const columns = Object.keys(app);
      await tx.run(
        `INSERT INTO apps (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((c) => app[c]),
      );
    }
    for (const entry of backup.entries) {
      const columns = Object.keys(entry);
      await tx.run(
        `INSERT INTO entries (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((c) => entry[c]),
      );
    }
    for (const event of backup.events) {
      const columns = Object.keys(event);
      await tx.run(
        `INSERT INTO events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((c) => event[c]),
      );
    }
  });

  // Postgres sequences do not follow explicitly-inserted ids, so the next
  // insert would collide with a restored row without this.
  if (adapter.dialect === 'postgres') {
    for (const table of ['apps', 'entries', 'events']) {
      await adapter.run(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
           GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`,
      );
    }
  }

  const after = await adapter.get('SELECT COUNT(*) AS total FROM entries');
  console.log(`\nRestored. The database now holds ${Number(after.total)} signup(s).`);
} catch (err) {
  console.error(`\nRestore failed: ${err.message}`);
  console.error('Nothing was committed; the database is as it was.');
  process.exitCode = 1;
} finally {
  await adapter.close();
}

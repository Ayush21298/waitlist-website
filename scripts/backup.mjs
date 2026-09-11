/**
 * Takes a complete, portable backup of the waitlist.
 *
 * Works against whichever database the app is configured for, reads it
 * directly rather than through the HTTP API, and needs no `pg_dump` or
 * `sqlite3` binary installed. That matters because the most likely moment to
 * need a backup is on a machine that is not the one the app usually runs on.
 *
 * Writes two files per run:
 *
 *   waitlist-<timestamp>.json   everything, restorable by restore.mjs
 *   waitlist-<timestamp>.csv    just the signups, openable in any spreadsheet
 *
 * The CSV exists because a backup you cannot read without the software that
 * made it is a backup you have to trust rather than verify.
 *
 * Usage:
 *   npm run backup
 *   npm run backup -- --out /path/to/backups --keep 30
 */
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../backend/src/config.js';
import { createStore } from '../backend/src/db/index.js';
import { Logger } from '../backend/src/logger.js';
import { toCsv } from '../backend/src/lib/export.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const OUT_DIR = path.resolve(args.get('out') ?? path.join(config.paths.root, 'backups'));
// 0 keeps everything. Otherwise the oldest runs are pruned after a successful
// backup, so an unattended schedule cannot fill the disk.
const KEEP = Number(args.get('keep') ?? 30);

const logger = new Logger({ level: 'error', sinks: [] });

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const { adapter, store } = await createStore(config, logger);

try {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Read everything through the adapter rather than the Store, because a
  // backup wants the rows exactly as stored, not a filtered view of them.
  const apps = await adapter.all('SELECT * FROM apps ORDER BY id');
  const entries = await adapter.all('SELECT * FROM entries ORDER BY app_id, position');
  const events = await adapter.all('SELECT * FROM events ORDER BY id');
  const migrations = await adapter.all('SELECT * FROM schema_migrations ORDER BY version');

  // Sessions and auth attempts are deliberately not backed up: they are
  // short-lived operational state, restoring them would resurrect sessions
  // that should have died, and they are the only tables holding anything
  // resembling a credential.
  const backup = {
    format: 'r2p-waitlist-backup',
    version: 1,
    takenAt: new Date().toISOString(),
    source: { dialect: adapter.dialect },
    schemaVersion: migrations.length ? Math.max(...migrations.map((m) => Number(m.version))) : 0,
    counts: { apps: apps.length, entries: entries.length, events: events.length },
    apps,
    entries,
    events,
  };

  const base = path.join(OUT_DIR, `waitlist-${stamp()}`);
  const jsonPath = `${base}.json`;
  fs.writeFileSync(jsonPath, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });

  // The human-readable half. Uses the same CSV writer the admin export does,
  // so formula injection is neutralised here too.
  const bySlug = new Map(apps.map((a) => [a.id, a.slug]));
  const csvPath = `${base}.csv`;
  fs.writeFileSync(
    csvPath,
    toCsv(
      [
        { key: 'app', label: 'App' },
        { key: 'position', label: 'Position' },
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Phone' },
        { key: 'status', label: 'Status' },
        { key: 'created_at', label: 'Signed Up (UTC)' },
        { key: 'note', label: 'Note' },
      ],
      entries.map((e) => ({ ...e, app: bySlug.get(e.app_id) ?? e.app_id })),
    ),
    { mode: 0o600 },
  );

  console.log(`Backup written to ${OUT_DIR}`);
  console.log(`  ${path.basename(jsonPath)}  ${human(fs.statSync(jsonPath).size)}  (complete, restorable)`);
  console.log(`  ${path.basename(csvPath)}  ${human(fs.statSync(csvPath).size)}  (signups, readable anywhere)`);
  console.log(`  ${backup.counts.entries} signups across ${backup.counts.apps} app(s), schema v${backup.schemaVersion}`);

  // Prune only after the new backup is safely on disk.
  if (KEEP > 0) {
    const runs = fs
      .readdirSync(OUT_DIR)
      .filter((f) => /^waitlist-.*\.json$/.test(f))
      .sort()
      .reverse();
    const stale = runs.slice(KEEP);
    for (const file of stale) {
      fs.rmSync(path.join(OUT_DIR, file), { force: true });
      fs.rmSync(path.join(OUT_DIR, file.replace(/\.json$/, '.csv')), { force: true });
    }
    if (stale.length) console.log(`  pruned ${stale.length} backup(s) older than the last ${KEEP}`);
  }
} catch (err) {
  console.error(`\nBackup failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await adapter.close();
}

/**
 * SQLite adapter (better-sqlite3).
 *
 * better-sqlite3 is synchronous, which is the right choice here: every query
 * in this service is an indexed lookup measured in microseconds, and a
 * synchronous call avoids the event-loop round trip an async driver adds. The
 * methods are still declared `async` so both adapters present one interface.
 *
 * Concurrency is handled by WAL mode, which lets readers proceed while a
 * single writer commits, plus a busy timeout so a contended write waits
 * rather than failing.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { buildMigrations, MIGRATIONS_TABLE } from './migrations.js';

export class SqliteAdapter {
  dialect = 'sqlite';

  #db;
  #logger;
  #statements = new Map();
  /** Serialises transactions; see `transaction`. */
  #txQueue = Promise.resolve();

  constructor({ file, logger }) {
    this.#logger = logger;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#db = new Database(file);

    // Write-ahead logging: concurrent readers are never blocked by a writer,
    // which is what keeps many devices polling the counter from queueing up.
    this.#db.pragma('journal_mode = WAL');
    // Fsync at checkpoints rather than every commit. Safe under WAL against
    // process crashes; only a host power loss can lose the last transactions.
    this.#db.pragma('synchronous = NORMAL');
    // A contended write waits up to five seconds instead of throwing SQLITE_BUSY.
    this.#db.pragma('busy_timeout = 5000');
    this.#db.pragma('foreign_keys = ON');
    // Keeps the WAL from growing without bound on a long-lived process.
    this.#db.pragma('wal_autocheckpoint = 1000');

    this.#logger?.info('sqlite opened', { file, journalMode: this.#db.pragma('journal_mode', { simple: true }) });
  }

  /** Statements are prepared once and reused; preparation dominates query cost. */
  #prepare(sql) {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  async all(sql, params = []) {
    return this.#prepare(sql).all(params);
  }

  async get(sql, params = []) {
    return this.#prepare(sql).get(params) ?? null;
  }

  async run(sql, params = []) {
    const info = this.#prepare(sql).run(params);
    return { changes: info.changes, lastId: Number(info.lastInsertRowid) };
  }

  /**
   * Runs `fn` inside an IMMEDIATE transaction, one at a time.
   *
   * IMMEDIATE takes the write lock up front. Without it, a transaction that
   * reads and then writes can fail at commit time under contention, which is
   * exactly the shape of assigning the next waitlist position.
   *
   * The queue matters just as much. SQLite transactions are a property of the
   * connection, not of the caller, and this adapter holds a single
   * connection. Because `fn` is awaited, two overlapping callers would
   * otherwise both reach `BEGIN` and the second would fail with "cannot start
   * a transaction within a transaction". Chaining onto a promise queue
   * serialises them instead. The work inside is synchronous, so the queue
   * drains in microseconds and never becomes a bottleneck.
   */
  async transaction(fn) {
    const result = this.#txQueue.then(
      () => this.#runTransaction(fn),
      () => this.#runTransaction(fn),
    );
    // The queue must survive a failed transaction, so swallow the outcome
    // here; the caller still receives the original promise, rejection and all.
    this.#txQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #runTransaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Rollback can fail if the transaction was already aborted; the
        // original error is the one worth propagating.
      }
      throw err;
    }
  }

  async migrate() {
    this.#db.exec(MIGRATIONS_TABLE);
    const applied = new Set(
      this.#db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
    );
    for (const migration of buildMigrations(this.dialect)) {
      if (applied.has(migration.version)) continue;
      const run = this.#db.transaction(() => {
        for (const statement of migration.statements) this.#db.exec(statement);
        this.#db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
      });
      run();
      this.#logger?.info('migration applied', { version: migration.version, name: migration.name });
    }
  }

  /** Reclaims space and refreshes the query planner's statistics. */
  async maintenance() {
    this.#db.pragma('wal_checkpoint(TRUNCATE)');
    this.#db.exec('ANALYZE');
  }

  async healthCheck() {
    const row = this.#db.prepare('SELECT 1 AS ok').get();
    return row?.ok === 1;
  }

  async close() {
    this.#statements.clear();
    this.#db.close();
  }
}

export default SqliteAdapter;

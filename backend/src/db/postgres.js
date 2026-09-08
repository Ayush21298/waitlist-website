/**
 * Postgres adapter (node-postgres).
 *
 * Used when DATABASE_URL is set, which is how the service runs on managed
 * free-tier hosting where the filesystem is ephemeral and SQLite would lose
 * the waitlist on every redeploy.
 *
 * Queries throughout the codebase are written with `?` placeholders so they
 * read identically for both engines; this adapter rewrites them to `$1..$n`.
 */
import pg from 'pg';

import { buildMigrations, MIGRATIONS_TABLE } from './migrations.js';

const { Pool } = pg;

// Postgres returns BIGINT as a string to avoid precision loss. Every 64-bit
// column here is an identifier or a count that stays far below 2^53, so
// parsing them as numbers keeps row shapes identical to the SQLite adapter.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

/**
 * Rewrites `?` placeholders to `$1..$n`.
 *
 * All SQL in this project is authored in-repo and never contains a literal
 * `?` inside a string literal, so a positional scan is sufficient and there
 * is no parsing to get wrong.
 */
export function toPositional(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

/** Wraps a checked-out client so nested calls reuse the transaction. */
class PostgresTransaction {
  dialect = 'postgres';

  #client;

  constructor(client) {
    this.#client = client;
  }

  async all(sql, params = []) {
    const result = await this.#client.query(toPositional(sql), params);
    return result.rows;
  }

  async get(sql, params = []) {
    const result = await this.#client.query(toPositional(sql), params);
    return result.rows[0] ?? null;
  }

  async run(sql, params = []) {
    const result = await this.#client.query(toPositional(sql), params);
    return { changes: result.rowCount ?? 0, lastId: result.rows[0]?.id ?? null };
  }
}

export class PostgresAdapter {
  dialect = 'postgres';

  #pool;
  #logger;

  constructor({ url, logger, poolMax, connectionTimeoutMs, statementTimeoutMs }) {
    this.#logger = logger;
    const needsTls = !/\b(localhost|127\.0\.0\.1)\b/.test(url) && !/sslmode=disable/.test(url);
    this.#pool = new Pool({
      connectionString: url,
      max: poolMax,
      connectionTimeoutMillis: connectionTimeoutMs,
      idleTimeoutMillis: 30_000,
      // A runaway query must not pin a pooled connection forever.
      statement_timeout: statementTimeoutMs,
      query_timeout: statementTimeoutMs,
      // Managed providers terminate connections that sit idle in a
      // transaction; failing fast is better than holding a lock.
      idle_in_transaction_session_timeout: 30_000,
      // Free-tier Postgres providers present certificates from a private CA.
      // TLS is still required and negotiated; only chain verification is
      // relaxed, which is the documented connection mode for these hosts.
      ssl: needsTls ? { rejectUnauthorized: false } : false,
    });
    // An idle client erroring (a provider restart, say) must not crash the
    // process; the pool discards it and the next query gets a fresh one.
    this.#pool.on('error', (err) => this.#logger?.error('postgres pool error', { err }));
  }

  async all(sql, params = []) {
    const result = await this.#pool.query(toPositional(sql), params);
    return result.rows;
  }

  async get(sql, params = []) {
    const result = await this.#pool.query(toPositional(sql), params);
    return result.rows[0] ?? null;
  }

  async run(sql, params = []) {
    const result = await this.#pool.query(toPositional(sql), params);
    return { changes: result.rowCount ?? 0, lastId: result.rows[0]?.id ?? null };
  }

  async transaction(fn) {
    const client = await this.#pool.connect();
    const handle = new PostgresTransaction(client);
    try {
      await client.query('BEGIN');
      const result = await fn(handle);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection may already be broken; propagate the original error.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async migrate() {
    const client = await this.#pool.connect();
    try {
      // A lock so that two instances booting at once cannot race the same
      // migration. Free-tier platforms routinely overlap old and new
      // deployments for a few seconds.
      await client.query('SELECT pg_advisory_lock(4919283746)');
      await client.query(MIGRATIONS_TABLE);
      const { rows } = await client.query('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map((r) => Number(r.version)));

      for (const migration of buildMigrations(this.dialect)) {
        if (applied.has(migration.version)) continue;
        await client.query('BEGIN');
        try {
          for (const statement of migration.statements) await client.query(statement);
          await client.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)', [
            migration.version,
            migration.name,
            new Date().toISOString(),
          ]);
          await client.query('COMMIT');
          this.#logger?.info('migration applied', { version: migration.version, name: migration.name });
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(4919283746)').catch(() => {});
      client.release();
    }
  }

  async maintenance() {
    await this.#pool.query('ANALYZE');
  }

  async healthCheck() {
    const result = await this.#pool.query('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  }

  async close() {
    await this.#pool.end();
  }
}

export default PostgresAdapter;

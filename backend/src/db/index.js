/**
 * Database bootstrap: chooses an adapter, migrates, and returns a Store.
 *
 * The choice is made by presence of DATABASE_URL alone. That keeps local
 * development on a zero-setup SQLite file while a deployment on ephemeral
 * free-tier infrastructure points at managed Postgres by setting one variable.
 */
import { PostgresAdapter } from './postgres.js';
import { SqliteAdapter } from './sqlite.js';
import { Store } from './store.js';

export async function createStore(config, logger) {
  const adapter = config.db.url
    ? new PostgresAdapter({
        url: config.db.url,
        logger,
        poolMax: config.db.poolMax,
        connectionTimeoutMs: config.db.connectionTimeoutMs,
        statementTimeoutMs: config.db.statementTimeoutMs,
      })
    : new SqliteAdapter({ file: config.db.sqlitePath, logger });

  logger.info('database selected', {
    dialect: adapter.dialect,
    target: config.db.url ? redactUrl(config.db.url) : config.db.sqlitePath,
  });

  await adapter.migrate();
  const store = new Store(adapter, logger);
  return { adapter, store };
}

/** Strips credentials so a connection string can safely appear in a log. */
export function redactUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '[unparseable connection string]';
  }
}

export { Store } from './store.js';
export { DuplicateEntryError } from './store.js';
export default createStore;

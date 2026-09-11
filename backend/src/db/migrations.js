/**
 * Schema migrations.
 *
 * Migrations are an ordered, append-only list. Each one runs inside a
 * transaction and is recorded in `schema_migrations`, so applying them is
 * idempotent and safe to run on every boot.
 *
 * Two dialects are supported: SQLite for local development and single-server
 * deployments, Postgres for managed free-tier hosting. Conventions that keep
 * the two schemas interchangeable:
 *
 *   - Timestamps are ISO-8601 UTC strings. They sort lexicographically, and
 *     they mean the same thing in both engines and in exported files.
 *   - Booleans are INTEGER 0/1 in both, so predicates are written once.
 *   - Identifiers are 64-bit integers, auto-assigned by the engine.
 */

/** @param {'sqlite'|'postgres'} dialect */
function idColumn(dialect) {
  return dialect === 'postgres' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
}

/** @param {'sqlite'|'postgres'} dialect */
export function buildMigrations(dialect) {
  const ID = idColumn(dialect);
  const FK = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';

  return [
    {
      version: 1,
      name: 'initial_schema',
      statements: [
        // ---- apps -------------------------------------------------------
        // One row per product sharing this backend. The slug is the public
        // identifier used in URLs and in the frontend bundle.
        `CREATE TABLE IF NOT EXISTS apps (
           id            ${ID},
           slug          TEXT NOT NULL UNIQUE,
           name          TEXT NOT NULL,
           description   TEXT NOT NULL DEFAULT '',
           is_active     INTEGER NOT NULL DEFAULT 1,
           collect_phone INTEGER NOT NULL DEFAULT 1,
           require_phone INTEGER NOT NULL DEFAULT 0,
           created_at    TEXT NOT NULL,
           updated_at    TEXT NOT NULL
         )`,

        // ---- entries ----------------------------------------------------
        // The waitlist itself. `position` is per-app and gap-free; it is the
        // number shown back to the person who signed up, so it is assigned
        // under a lock rather than derived from a global sequence.
        `CREATE TABLE IF NOT EXISTS entries (
           id           ${ID},
           app_id       ${FK} NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
           position     INTEGER NOT NULL,
           -- May be empty: an app can be configured to collect an email
           -- address and nothing else. NOT NULL still holds; '' is the
           -- "not collected" value, which keeps every query total.
           name         TEXT NOT NULL,
           email        TEXT NOT NULL,
           email_key    TEXT NOT NULL,
           phone        TEXT NOT NULL DEFAULT '',
           phone_key    TEXT NOT NULL DEFAULT '',
           status       TEXT NOT NULL DEFAULT 'pending',
           note         TEXT NOT NULL DEFAULT '',
           locale       TEXT NOT NULL DEFAULT '',
           source       TEXT NOT NULL DEFAULT '',
           referrer     TEXT NOT NULL DEFAULT '',
           user_agent   TEXT NOT NULL DEFAULT '',
           ip_hash      TEXT NOT NULL DEFAULT '',
           created_at   TEXT NOT NULL,
           updated_at   TEXT NOT NULL,
           CONSTRAINT entries_app_email_unique UNIQUE (app_id, email_key),
           CONSTRAINT entries_app_position_unique UNIQUE (app_id, position)
         )`,
        `CREATE INDEX IF NOT EXISTS entries_app_created_idx ON entries (app_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS entries_app_status_idx  ON entries (app_id, status)`,
        `CREATE INDEX IF NOT EXISTS entries_email_key_idx   ON entries (email_key)`,
        `CREATE INDEX IF NOT EXISTS entries_phone_key_idx   ON entries (phone_key)`,

        // ---- events -----------------------------------------------------
        // The queryable activity trail. Everything the system does that is
        // worth explaining later lands here; the rotating log file is the
        // firehose, this is the record an administrator can search.
        `CREATE TABLE IF NOT EXISTS events (
           id         ${ID},
           ts         TEXT NOT NULL,
           type       TEXT NOT NULL,
           severity   TEXT NOT NULL DEFAULT 'info',
           app_id     ${FK} NULL REFERENCES apps(id) ON DELETE SET NULL,
           entry_id   ${FK} NULL,
           actor      TEXT NOT NULL DEFAULT 'system',
           request_id TEXT NOT NULL DEFAULT '',
           ip_hash    TEXT NOT NULL DEFAULT '',
           message    TEXT NOT NULL DEFAULT '',
           detail     TEXT NOT NULL DEFAULT '{}'
         )`,
        `CREATE INDEX IF NOT EXISTS events_ts_idx        ON events (ts DESC)`,
        `CREATE INDEX IF NOT EXISTS events_type_ts_idx   ON events (type, ts DESC)`,
        `CREATE INDEX IF NOT EXISTS events_app_ts_idx    ON events (app_id, ts DESC)`,

        // ---- sessions ---------------------------------------------------
        // Only the digest of a session token is stored, so a database leak
        // yields no usable sessions. Rows are kept (not deleted) on logout so
        // that the activity trail can still refer to them.
        `CREATE TABLE IF NOT EXISTS sessions (
           id           TEXT PRIMARY KEY,
           kind         TEXT NOT NULL,
           token_hash   TEXT NOT NULL,
           csrf_token   TEXT NOT NULL,
           created_at   TEXT NOT NULL,
           expires_at   TEXT NOT NULL,
           last_seen_at TEXT NOT NULL,
           ip_hash      TEXT NOT NULL DEFAULT '',
           ua_hash      TEXT NOT NULL DEFAULT '',
           revoked_at   TEXT NULL
         )`,
        `CREATE INDEX IF NOT EXISTS sessions_kind_expires_idx ON sessions (kind, expires_at)`,

        // ---- auth_attempts ----------------------------------------------
        // Drives rate limiting and lockout, and survives a process restart so
        // an attacker cannot reset their budget by waiting for a redeploy.
        `CREATE TABLE IF NOT EXISTS auth_attempts (
           id         ${ID},
           ts         TEXT NOT NULL,
           kind       TEXT NOT NULL,
           ip_hash    TEXT NOT NULL,
           success    INTEGER NOT NULL,
           request_id TEXT NOT NULL DEFAULT ''
         )`,
        `CREATE INDEX IF NOT EXISTS auth_attempts_lookup_idx ON auth_attempts (kind, ip_hash, ts DESC)`,
      ],
    },

    {
      version: 2,
      name: 'per_app_name_and_capacity',
      statements: [
        // Not every product asks for a name. C-Dots collects an email address
        // and nothing else, so whether a name is collected -- and whether it
        // is mandatory -- has to be a property of the app rather than of the
        // whole platform. Both default to 1 so existing apps are unchanged.
        `ALTER TABLE apps ADD COLUMN collect_name INTEGER NOT NULL DEFAULT 1`,
        `ALTER TABLE apps ADD COLUMN require_name INTEGER NOT NULL DEFAULT 1`,

        // A limited beta advertises places remaining rather than signups so
        // far. 0 means no limit, which is what every existing app wants.
        `ALTER TABLE apps ADD COLUMN capacity INTEGER NOT NULL DEFAULT 0`,

        // Entries predating this migration always carried a name, and the
        // column is NOT NULL, so nothing needs backfilling.
      ],
    },

    {
      version: 3,
      name: 'pages_capacity_and_no_phone',
      statements: [
        // The Pages landing page became a fifty-place beta and stopped asking
        // for a phone number. `ensureApps` only creates apps that are missing,
        // deliberately, so that edits made in the admin panel are never
        // overwritten on restart -- which means an existing database needs
        // this one-off reconciliation to match the shipped design.
        //
        // Scoped to the seeded slug and to the values it had before, so an
        // operator who has already set a capacity or re-enabled the phone
        // field on purpose keeps their choice.
        `UPDATE apps SET capacity = 50 WHERE slug = 'pages' AND capacity = 0`,
        `UPDATE apps SET collect_phone = 0 WHERE slug = 'pages' AND collect_phone = 1`,

        // Phone numbers already collected are left untouched: they are real
        // data someone gave us, and they still appear in the admin list and
        // in exports.
      ],
    },
  ];
}

export const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

export default buildMigrations;

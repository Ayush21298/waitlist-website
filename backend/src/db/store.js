/**
 * Domain queries.
 *
 * Every statement the application issues lives here, written once against the
 * adapter interface with `?` placeholders. Nothing outside this file builds
 * SQL, and no value is ever interpolated into a statement: identifiers that
 * must vary (sort columns, sort direction) are mapped through allow-lists, so
 * there is no path from user input to SQL text.
 */
import { ENTRY_STATUSES } from '../lib/validate.js';

/** Thrown when a signup collides with an existing entry for the same app. */
export class DuplicateEntryError extends Error {
  constructor(existing) {
    super('This email address is already on the waitlist.');
    this.name = 'DuplicateEntryError';
    this.code = 'duplicate_email';
    this.status = 409;
    this.existing = existing;
  }
}

/** Recognises a unique-constraint violation from either engine. */
function isUniqueViolation(err) {
  return (
    err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    err?.code === '23505'
  );
}

const nowIso = () => new Date().toISOString();

/** Columns an administrator is allowed to sort by, mapped to real SQL. */
const ENTRY_SORT_COLUMNS = {
  position: 'e.position',
  created_at: 'e.created_at',
  name: 'e.name',
  email: 'e.email',
  status: 'e.status',
};

export class Store {
  #db;
  #logger;

  constructor(db, logger) {
    this.#db = db;
    this.#logger = logger;
  }

  get dialect() {
    return this.#db.dialect;
  }

  /**
   * Appends `RETURNING id` on Postgres, where there is no lastInsertRowid.
   * @returns {Promise<number>} the new row's identifier
   */
  async #insertReturningId(handle, sql, params) {
    if (handle.dialect === 'postgres') {
      const row = await handle.get(`${sql} RETURNING id`, params);
      return Number(row.id);
    }
    const result = await handle.run(sql, params);
    return result.lastId;
  }

  /* ---------------------------------------------------------------- *
   * Apps
   * ---------------------------------------------------------------- */

  async listApps({ includeInactive = true } = {}) {
    const where = includeInactive ? '' : 'WHERE is_active = 1';
    return this.#db.all(`SELECT * FROM apps ${where} ORDER BY name ASC`);
  }

  async getAppBySlug(slug) {
    return this.#db.get('SELECT * FROM apps WHERE slug = ?', [slug]);
  }

  async getAppById(id) {
    return this.#db.get('SELECT * FROM apps WHERE id = ?', [id]);
  }

  async createApp({ slug, name, description = '', isActive = true, collectPhone = true, requirePhone = false }) {
    const ts = nowIso();
    const id = await this.#insertReturningId(
      this.#db,
      `INSERT INTO apps (slug, name, description, is_active, collect_phone, require_phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [slug, name, description, isActive ? 1 : 0, collectPhone ? 1 : 0, requirePhone ? 1 : 0, ts, ts],
    );
    return this.getAppById(id);
  }

  async updateApp(id, fields) {
    const allowed = {
      name: 'name',
      description: 'description',
      isActive: 'is_active',
      collectPhone: 'collect_phone',
      requirePhone: 'require_phone',
    };
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(allowed)) {
      if (fields[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(typeof fields[key] === 'boolean' ? (fields[key] ? 1 : 0) : fields[key]);
    }
    if (!sets.length) return this.getAppById(id);
    sets.push('updated_at = ?');
    params.push(nowIso(), id);
    await this.#db.run(`UPDATE apps SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.getAppById(id);
  }

  /** Creates any app in `defs` that does not already exist. Idempotent. */
  async ensureApps(defs) {
    for (const def of defs) {
      const existing = await this.getAppBySlug(def.slug);
      if (existing) continue;
      await this.createApp(def);
      this.#logger?.info('app provisioned', { slug: def.slug, name: def.name });
    }
  }

  /* ---------------------------------------------------------------- *
   * Entries
   * ---------------------------------------------------------------- */

  /**
   * Inserts a waitlist entry and returns it with its assigned position.
   *
   * Position is allocated inside the same transaction as the insert, under a
   * per-app write lock, so two simultaneous signups can never receive the
   * same number. On SQLite the IMMEDIATE transaction provides that lock; on
   * Postgres the app row is locked with FOR UPDATE.
   */
  async createEntry(entry) {
    const ts = nowIso();
    try {
      return await this.#db.transaction(async (tx) => {
        if (tx.dialect === 'postgres') {
          await tx.get('SELECT id FROM apps WHERE id = ? FOR UPDATE', [entry.appId]);
        }

        // A duplicate is answered with the original entry rather than an
        // opaque error, so the frontend can show the person the number they
        // already hold instead of a dead end.
        const existing = await tx.get('SELECT * FROM entries WHERE app_id = ? AND email_key = ?', [
          entry.appId,
          entry.emailKey,
        ]);
        if (existing) throw new DuplicateEntryError(existing);

        const row = await tx.get(
          'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM entries WHERE app_id = ?',
          [entry.appId],
        );
        const position = Number(row.next);

        const id = await this.#insertReturningId(
          tx,
          `INSERT INTO entries
             (app_id, position, name, email, email_key, phone, phone_key, status, note,
              locale, source, referrer, user_agent, ip_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.appId,
            position,
            entry.name,
            entry.email,
            entry.emailKey,
            entry.phone ?? '',
            entry.phoneKey ?? '',
            entry.locale ?? '',
            entry.source ?? '',
            entry.referrer ?? '',
            entry.userAgent ?? '',
            entry.ipHash ?? '',
            ts,
            ts,
          ],
        );

        return tx.get('SELECT * FROM entries WHERE id = ?', [id]);
      });
    } catch (err) {
      if (err instanceof DuplicateEntryError) throw err;
      // A concurrent insert can still lose the unique-constraint race even
      // with the lock, for instance across two processes on Postgres. Resolve
      // it the same way the in-transaction check does.
      if (isUniqueViolation(err)) {
        const existing = await this.#db.get('SELECT * FROM entries WHERE app_id = ? AND email_key = ?', [
          entry.appId,
          entry.emailKey,
        ]);
        if (existing) throw new DuplicateEntryError(existing);
      }
      throw err;
    }
  }

  async getEntryById(id) {
    return this.#db.get('SELECT * FROM entries WHERE id = ?', [id]);
  }

  /** Public counter. Removed entries are excluded so the number never jumps back. */
  async countEntries(appId) {
    const row = await this.#db.get(
      "SELECT COUNT(*) AS total FROM entries WHERE app_id = ? AND status <> 'removed'",
      [appId],
    );
    return Number(row?.total ?? 0);
  }

  /**
   * Filtered, paginated listing for the admin panel.
   *
   * `sort` and `direction` are mapped through allow-lists rather than
   * interpolated, so no query parameter can reach the SQL text.
   */
  async listEntries({
    appId = null,
    status = null,
    search = '',
    limit = 50,
    offset = 0,
    sort = 'position',
    direction = 'asc',
  } = {}) {
    const clauses = [];
    const params = [];

    if (appId) {
      clauses.push('e.app_id = ?');
      params.push(appId);
    }
    if (status) {
      clauses.push('e.status = ?');
      params.push(status);
    }
    if (search) {
      const term = `%${search.toLowerCase()}%`;
      clauses.push('(LOWER(e.name) LIKE ? OR e.email_key LIKE ? OR e.phone_key LIKE ?)');
      params.push(term, term, term);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const orderColumn = ENTRY_SORT_COLUMNS[sort] ?? ENTRY_SORT_COLUMNS.position;
    const orderDirection = String(direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const totalRow = await this.#db.get(`SELECT COUNT(*) AS total FROM entries e ${where}`, params);

    const rows = await this.#db.all(
      `SELECT e.*, a.slug AS app_slug, a.name AS app_name
         FROM entries e
         JOIN apps a ON a.id = e.app_id
         ${where}
        ORDER BY ${orderColumn} ${orderDirection}, e.id ASC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return { rows, total: Number(totalRow?.total ?? 0) };
  }

  /** Unpaginated variant used by the export endpoints, hard-capped by caller. */
  async listEntriesForExport({ appId = null, status = null, search = '', limit = 100_000 } = {}) {
    const { rows } = await this.listEntries({
      appId,
      status,
      search,
      limit,
      offset: 0,
      sort: 'position',
      direction: 'asc',
    });
    return rows;
  }

  async updateEntry(id, { status, note }) {
    const sets = [];
    const params = [];
    if (status !== undefined) {
      sets.push('status = ?');
      params.push(status);
    }
    if (note !== undefined) {
      sets.push('note = ?');
      params.push(note);
    }
    if (!sets.length) return this.getEntryById(id);
    sets.push('updated_at = ?');
    params.push(nowIso(), id);
    await this.#db.run(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.getEntryById(id);
  }

  async deleteEntry(id) {
    const result = await this.#db.run('DELETE FROM entries WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /* ---------------------------------------------------------------- *
   * Statistics
   * ---------------------------------------------------------------- */

  /** Per-app totals, status breakdown and recent-window counts. */
  async statsByApp() {
    const rows = await this.#db.all(
      `SELECT a.id, a.slug, a.name, a.is_active,
              COUNT(e.id)                                              AS total,
              SUM(CASE WHEN e.status = 'pending' THEN 1 ELSE 0 END)    AS pending,
              SUM(CASE WHEN e.status = 'invited' THEN 1 ELSE 0 END)    AS invited,
              SUM(CASE WHEN e.status = 'joined'  THEN 1 ELSE 0 END)    AS joined,
              SUM(CASE WHEN e.status = 'removed' THEN 1 ELSE 0 END)    AS removed,
              SUM(CASE WHEN e.phone <> ''        THEN 1 ELSE 0 END)    AS with_phone,
              SUM(CASE WHEN e.created_at >= ?    THEN 1 ELSE 0 END)    AS last_24h,
              SUM(CASE WHEN e.created_at >= ?    THEN 1 ELSE 0 END)    AS last_7d,
              MAX(e.created_at)                                        AS last_signup_at
         FROM apps a
         LEFT JOIN entries e ON e.app_id = a.id
        GROUP BY a.id, a.slug, a.name, a.is_active
        ORDER BY a.name ASC`,
      [isoAgo(24 * 60 * 60 * 1000), isoAgo(7 * 24 * 60 * 60 * 1000)],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      slug: row.slug,
      name: row.name,
      isActive: Number(row.is_active) === 1,
      total: Number(row.total ?? 0),
      pending: Number(row.pending ?? 0),
      invited: Number(row.invited ?? 0),
      joined: Number(row.joined ?? 0),
      removed: Number(row.removed ?? 0),
      withPhone: Number(row.with_phone ?? 0),
      last24h: Number(row.last_24h ?? 0),
      last7d: Number(row.last_7d ?? 0),
      lastSignupAt: row.last_signup_at ?? null,
    }));
  }

  /**
   * Daily signup counts for the last `days` days.
   *
   * Grouping on the date prefix of the ISO timestamp works identically in
   * both engines and needs no timezone handling: everything is stored in UTC.
   */
  async signupsByDay({ appId = null, days = 30 } = {}) {
    const since = isoAgo(days * 24 * 60 * 60 * 1000);
    const params = [since];
    let where = 'WHERE created_at >= ?';
    if (appId) {
      where += ' AND app_id = ?';
      params.push(appId);
    }
    const rows = await this.#db.all(
      `SELECT SUBSTR(created_at, 1, 10) AS day, COUNT(*) AS count
         FROM entries ${where}
        GROUP BY SUBSTR(created_at, 1, 10)
        ORDER BY day ASC`,
      params,
    );
    return rows.map((r) => ({ day: r.day, count: Number(r.count) }));
  }

  /** Top referrer/source values, for judging where signups come from. */
  async topSources({ appId = null, limit = 10 } = {}) {
    const params = [];
    let where = "WHERE source <> ''";
    if (appId) {
      where += ' AND app_id = ?';
      params.push(appId);
    }
    const rows = await this.#db.all(
      `SELECT source, COUNT(*) AS count FROM entries ${where}
        GROUP BY source ORDER BY count DESC, source ASC LIMIT ?`,
      [...params, limit],
    );
    return rows.map((r) => ({ source: r.source, count: Number(r.count) }));
  }

  /* ---------------------------------------------------------------- *
   * Events (activity trail)
   * ---------------------------------------------------------------- */

  async recordEvent({
    type,
    severity = 'info',
    appId = null,
    entryId = null,
    actor = 'system',
    requestId = '',
    ipHash = '',
    message = '',
    detail = {},
  }) {
    let serialised;
    try {
      serialised = JSON.stringify(detail ?? {});
    } catch {
      serialised = '{"error":"detail not serialisable"}';
    }
    await this.#db.run(
      `INSERT INTO events (ts, type, severity, app_id, entry_id, actor, request_id, ip_hash, message, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [nowIso(), type, severity, appId, entryId, actor, requestId, ipHash, message, serialised],
    );
  }

  async listEvents({ appId = null, type = null, severity = null, search = '', limit = 100, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (appId) {
      clauses.push('ev.app_id = ?');
      params.push(appId);
    }
    if (type) {
      clauses.push('ev.type = ?');
      params.push(type);
    }
    if (severity) {
      clauses.push('ev.severity = ?');
      params.push(severity);
    }
    if (search) {
      const term = `%${search.toLowerCase()}%`;
      clauses.push('(LOWER(ev.message) LIKE ? OR LOWER(ev.type) LIKE ? OR LOWER(ev.detail) LIKE ?)');
      params.push(term, term, term);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const totalRow = await this.#db.get(`SELECT COUNT(*) AS total FROM events ev ${where}`, params);
    const rows = await this.#db.all(
      `SELECT ev.*, a.slug AS app_slug
         FROM events ev
         LEFT JOIN apps a ON a.id = ev.app_id
         ${where}
        ORDER BY ev.ts DESC, ev.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { rows, total: Number(totalRow?.total ?? 0) };
  }

  async distinctEventTypes() {
    const rows = await this.#db.all('SELECT DISTINCT type FROM events ORDER BY type ASC');
    return rows.map((r) => r.type);
  }

  async pruneEvents(retentionDays) {
    const cutoff = isoAgo(retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.#db.run('DELETE FROM events WHERE ts < ?', [cutoff]);
    return result.changes;
  }

  /* ---------------------------------------------------------------- *
   * Sessions
   * ---------------------------------------------------------------- */

  async createSession({ id, kind, tokenHash, csrfToken, expiresAt, ipHash = '', uaHash = '' }) {
    const ts = nowIso();
    await this.#db.run(
      `INSERT INTO sessions (id, kind, token_hash, csrf_token, created_at, expires_at, last_seen_at, ip_hash, ua_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, kind, tokenHash, csrfToken, ts, expiresAt, ts, ipHash, uaHash],
    );
    return { id, kind, csrfToken, createdAt: ts, expiresAt, lastSeenAt: ts };
  }

  async getSession(id) {
    return this.#db.get('SELECT * FROM sessions WHERE id = ?', [id]);
  }

  async touchSession(id, lastSeenAt = nowIso()) {
    await this.#db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [lastSeenAt, id]);
  }

  async revokeSession(id) {
    await this.#db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [nowIso(), id]);
  }

  async revokeAllSessions(kind) {
    const result = await this.#db.run('UPDATE sessions SET revoked_at = ? WHERE kind = ? AND revoked_at IS NULL', [
      nowIso(),
      kind,
    ]);
    return result.changes;
  }

  async countActiveSessions(kind) {
    const row = await this.#db.get(
      'SELECT COUNT(*) AS total FROM sessions WHERE kind = ? AND revoked_at IS NULL AND expires_at > ?',
      [kind, nowIso()],
    );
    return Number(row?.total ?? 0);
  }

  /** Expired sessions are useless; keeping them only grows the table. */
  async pruneSessions() {
    const result = await this.#db.run('DELETE FROM sessions WHERE expires_at < ?', [isoAgo(24 * 60 * 60 * 1000)]);
    return result.changes;
  }

  /* ---------------------------------------------------------------- *
   * Authentication attempts
   * ---------------------------------------------------------------- */

  async recordAuthAttempt({ kind, ipHash, success, requestId = '' }) {
    await this.#db.run(
      'INSERT INTO auth_attempts (ts, kind, ip_hash, success, request_id) VALUES (?, ?, ?, ?, ?)',
      [nowIso(), kind, ipHash, success ? 1 : 0, requestId],
    );
  }

  /**
   * Consecutive failures since the last success, which is what an exponential
   * lockout should be based on: one correct password clears the penalty.
   */
  async consecutiveFailures({ kind, ipHash, windowMs }) {
    const since = isoAgo(windowMs);
    const rows = await this.#db.all(
      `SELECT success, ts FROM auth_attempts
        WHERE kind = ? AND ip_hash = ? AND ts >= ?
        ORDER BY ts DESC, id DESC
        LIMIT 100`,
      [kind, ipHash, since],
    );
    let failures = 0;
    let lastFailureAt = null;
    for (const row of rows) {
      if (Number(row.success) === 1) break;
      failures += 1;
      if (!lastFailureAt) lastFailureAt = row.ts;
    }
    return { failures, lastFailureAt };
  }

  async countAttempts({ kind, ipHash, windowMs }) {
    const row = await this.#db.get(
      'SELECT COUNT(*) AS total FROM auth_attempts WHERE kind = ? AND ip_hash = ? AND ts >= ?',
      [kind, ipHash, isoAgo(windowMs)],
    );
    return Number(row?.total ?? 0);
  }

  async pruneAuthAttempts(retentionMs = 30 * 24 * 60 * 60 * 1000) {
    const result = await this.#db.run('DELETE FROM auth_attempts WHERE ts < ?', [isoAgo(retentionMs)]);
    return result.changes;
  }

  /* ---------------------------------------------------------------- *
   * Rate limiting support
   * ---------------------------------------------------------------- */

  /** Signup attempts from one address, used to slow down bulk submissions. */
  async countRecentSignups({ ipHash, windowMs }) {
    const row = await this.#db.get('SELECT COUNT(*) AS total FROM entries WHERE ip_hash = ? AND created_at >= ?', [
      ipHash,
      isoAgo(windowMs),
    ]);
    return Number(row?.total ?? 0);
  }

  async healthCheck() {
    return this.#db.healthCheck();
  }

  async maintenance() {
    return this.#db.maintenance();
  }
}

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

export { ENTRY_STATUSES };
export default Store;

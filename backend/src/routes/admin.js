/**
 * Admin API.
 *
 * Everything here sits behind the site gate and, on top of it, its own
 * password. Reads require a session; writes additionally require a
 * session-bound CSRF token and a same-origin request.
 *
 *   POST   /api/v1/admin/login | /logout
 *   GET    /api/v1/admin/session | /overview
 *   GET    /api/v1/admin/apps            POST /apps       PATCH /apps/:id
 *   GET    /api/v1/admin/entries         PATCH /entries/:id   DELETE /entries/:id
 *   GET    /api/v1/admin/entries/export
 *   GET    /api/v1/admin/events          GET /events/export
 */
import express from 'express';

import { FORMATS, exportFilename } from '../lib/export.js';
import { rateLimit, SlidingWindowLimiter } from '../middleware/ratelimit.js';
import { requireAdmin, requireCsrf } from '../middleware/auth.js';
import {
  ENTRY_STATUSES,
  intParam,
  searchTerm,
  validateName,
  validateNote,
  validateSlug,
  validateStatus,
  ValidationError,
} from '../lib/validate.js';

/** Columns exported by default: the contact list an operator actually wants. */
const BASE_EXPORT_COLUMNS = [
  { key: 'position', label: 'Position' },
  { key: 'app_name', label: 'App' },
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'status', label: 'Status' },
  { key: 'created_at', label: 'Signed Up (UTC)' },
  { key: 'note', label: 'Note' },
];

/** Added with ?include=meta, for attribution and abuse investigation. */
const META_EXPORT_COLUMNS = [
  { key: 'source', label: 'Source' },
  { key: 'referrer', label: 'Referrer' },
  { key: 'locale', label: 'Locale' },
  { key: 'user_agent', label: 'User Agent' },
  { key: 'ip_hash', label: 'IP Pseudonym' },
  { key: 'updated_at', label: 'Updated (UTC)' },
];

const EVENT_EXPORT_COLUMNS = [
  { key: 'ts', label: 'Timestamp (UTC)' },
  { key: 'type', label: 'Type' },
  { key: 'severity', label: 'Severity' },
  { key: 'app_slug', label: 'App' },
  { key: 'actor', label: 'Actor' },
  { key: 'message', label: 'Message' },
  { key: 'entry_id', label: 'Entry ID' },
  { key: 'request_id', label: 'Request ID' },
  { key: 'ip_hash', label: 'IP Pseudonym' },
  { key: 'detail', label: 'Detail' },
];

export function adminRoutes({ config, store, auth, logger }) {
  const router = express.Router();

  const loginLimiter = new SlidingWindowLimiter(config.rateLimit.login);
  const apiLimiter = new SlidingWindowLimiter(config.rateLimit.admin);
  const exportLimiter = new SlidingWindowLimiter(config.rateLimit.export);

  /* ---------------- authentication ---------------- */

  router.post('/login', rateLimit({ limiter: loginLimiter, name: 'admin-login' }), async (req, res, next) => {
    try {
      const password = typeof req.body?.password === 'string' ? req.body.password : '';

      const lockout = await auth.lockoutStatus('admin', req.ipHash);
      if (lockout.locked) {
        const retryAfterSeconds = Math.ceil(lockout.retryAfterMs / 1000);
        res.setHeader('Retry-After', String(retryAfterSeconds));
        req.log.warn('admin login locked out', { failures: lockout.failures, retryAfterSeconds });
        req.recordEvent({
          type: 'admin.locked_out',
          severity: 'warn',
          actor: 'admin',
          message: 'Admin login locked after repeated failures',
          detail: { failures: lockout.failures, retryAfterSeconds },
        });
        res.status(429).json({
          ok: false,
          error: 'locked_out',
          message: `Too many attempts. Try again in ${retryAfterSeconds} seconds.`,
          retryAfterSeconds,
        });
        return;
      }

      const valid = await auth.verifyPasswordFor('admin', password);
      await store.recordAuthAttempt({ kind: 'admin', ipHash: req.ipHash, success: valid, requestId: req.id });

      if (!valid) {
        req.log.warn('admin login failed');
        req.recordEvent({
          type: 'admin.login_failed',
          severity: 'warn',
          actor: 'admin',
          message: 'Incorrect admin password',
        });
        res.status(401).json({ ok: false, error: 'invalid_password', message: 'Incorrect password.' });
        return;
      }

      loginLimiter.reset(req.ipHash);
      const session = await auth.createSession('admin', req, res);
      req.log.info('admin login succeeded', { sessionId: session.id });
      req.recordEvent({
        type: 'admin.login',
        actor: 'admin',
        message: 'Administrator signed in',
        detail: { sessionId: session.id },
      });

      res.json({ ok: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const session = await auth.resolveSession('admin', req);
      await auth.revokeSession('admin', req, res);
      if (session) {
        req.recordEvent({
          type: 'admin.logout',
          actor: 'admin',
          message: 'Administrator signed out',
          detail: { sessionId: session.id },
        });
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Everything below requires an authenticated administrator.
  router.use(rateLimit({ limiter: apiLimiter, name: 'admin-api' }));
  router.use(requireAdmin(auth));
  router.use(requireCsrf());

  router.get('/session', (req, res) => {
    res.json({
      ok: true,
      authenticated: true,
      csrfToken: req.adminSession.csrf_token,
      expiresAt: req.adminSession.expires_at,
      idleTimeoutMs: config.auth.adminIdleTimeoutMs,
    });
  });

  /* ---------------- overview ---------------- */

  router.get('/overview', async (req, res, next) => {
    try {
      const perApp = await store.statsByApp();
      const totals = perApp.reduce(
        (acc, app) => ({
          total: acc.total + app.total,
          pending: acc.pending + app.pending,
          invited: acc.invited + app.invited,
          joined: acc.joined + app.joined,
          removed: acc.removed + app.removed,
          withPhone: acc.withPhone + app.withPhone,
          last24h: acc.last24h + app.last24h,
          last7d: acc.last7d + app.last7d,
        }),
        { total: 0, pending: 0, invited: 0, joined: 0, removed: 0, withPhone: 0, last24h: 0, last7d: 0 },
      );

      const appId = req.query.appId ? Number(req.query.appId) : null;
      const [byDay, sources, activeAdmins, activeGates] = await Promise.all([
        store.signupsByDay({ appId, days: intParam(req.query.days, { min: 7, max: 180, fallback: 30 }) }),
        store.topSources({ appId, limit: 8 }),
        store.countActiveSessions('admin'),
        store.countActiveSessions('gate'),
      ]);

      res.json({
        ok: true,
        totals,
        apps: perApp,
        signupsByDay: byDay,
        topSources: sources,
        sessions: { admin: activeAdmins, gate: activeGates },
        server: {
          dialect: store.dialect,
          uptimeSeconds: Math.floor(process.uptime()),
          nodeEnv: config.nodeEnv,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /* ---------------- apps ---------------- */

  router.get('/apps', async (req, res, next) => {
    try {
      const apps = await store.listApps();
      res.json({
        ok: true,
        apps: apps.map((a) => ({
          id: Number(a.id),
          slug: a.slug,
          name: a.name,
          description: a.description,
          isActive: Number(a.is_active) === 1,
          collectPhone: Number(a.collect_phone) === 1,
          requirePhone: Number(a.require_phone) === 1,
          createdAt: a.created_at,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/apps', async (req, res, next) => {
    try {
      const slug = validateSlug(req.body?.slug);
      const name = validateName(req.body?.name, { maxLength: 80 });
      if (await store.getAppBySlug(slug)) {
        res.status(409).json({ ok: false, error: 'app_exists', message: 'An app with that identifier already exists.' });
        return;
      }
      const app = await store.createApp({
        slug,
        name,
        description: validateNote(req.body?.description ?? '', { maxLength: 300 }),
        collectPhone: req.body?.collectPhone !== false,
        requirePhone: req.body?.requirePhone === true,
      });
      req.recordEvent({
        type: 'admin.app_created',
        actor: 'admin',
        appId: app.id,
        message: `App "${app.name}" created`,
        detail: { slug: app.slug },
      });
      res.status(201).json({ ok: true, app: { id: Number(app.id), slug: app.slug, name: app.name } });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/apps/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existing = await store.getAppById(id);
      if (!existing) {
        res.status(404).json({ ok: false, error: 'app_not_found', message: 'Unknown app.' });
        return;
      }
      const fields = {};
      if (req.body?.name !== undefined) fields.name = validateName(req.body.name, { maxLength: 80 });
      if (req.body?.description !== undefined) {
        fields.description = validateNote(req.body.description, { maxLength: 300 });
      }
      if (req.body?.isActive !== undefined) fields.isActive = req.body.isActive === true;
      if (req.body?.collectPhone !== undefined) fields.collectPhone = req.body.collectPhone === true;
      if (req.body?.requirePhone !== undefined) fields.requirePhone = req.body.requirePhone === true;

      const app = await store.updateApp(id, fields);
      req.recordEvent({
        type: 'admin.app_updated',
        actor: 'admin',
        appId: id,
        message: `App "${app.name}" updated`,
        detail: { fields: Object.keys(fields) },
      });
      res.json({ ok: true, app: { id: Number(app.id), slug: app.slug, name: app.name } });
    } catch (err) {
      next(err);
    }
  });

  /* ---------------- entries ---------------- */

  /** Shared parsing for the list and export endpoints. */
  function entryQuery(req) {
    const status = req.query.status ? validateStatus(req.query.status) : null;
    return {
      appId: req.query.appId ? Number(req.query.appId) : null,
      status,
      search: searchTerm(req.query.search ?? ''),
    };
  }

  function entryView(row) {
    return {
      id: Number(row.id),
      appId: Number(row.app_id),
      appSlug: row.app_slug,
      appName: row.app_name,
      position: Number(row.position),
      name: row.name,
      email: row.email,
      phone: row.phone,
      status: row.status,
      note: row.note,
      source: row.source,
      referrer: row.referrer,
      locale: row.locale,
      userAgent: row.user_agent,
      ipHash: row.ip_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  router.get('/entries', async (req, res, next) => {
    try {
      const limit = intParam(req.query.limit, { min: 1, max: config.limits.maxPageSize, fallback: 50 });
      const offset = intParam(req.query.offset, { min: 0, max: 1_000_000, fallback: 0 });
      const { rows, total } = await store.listEntries({
        ...entryQuery(req),
        limit,
        offset,
        sort: req.query.sort ?? 'position',
        direction: req.query.direction ?? 'asc',
      });
      res.json({ ok: true, total, limit, offset, statuses: ENTRY_STATUSES, entries: rows.map(entryView) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/entries/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existing = await store.getEntryById(id);
      if (!existing) {
        res.status(404).json({ ok: false, error: 'entry_not_found', message: 'Unknown entry.' });
        return;
      }
      const fields = {};
      if (req.body?.status !== undefined) fields.status = validateStatus(req.body.status);
      if (req.body?.note !== undefined) {
        fields.note = validateNote(req.body.note, { maxLength: config.limits.maxNoteLength });
      }
      if (!Object.keys(fields).length) {
        throw new ValidationError('body', 'no_changes', 'Provide a status or a note to update.');
      }

      const entry = await store.updateEntry(id, fields);
      req.recordEvent({
        type: 'admin.entry_updated',
        actor: 'admin',
        appId: Number(existing.app_id),
        entryId: id,
        message: `Entry #${existing.position} updated`,
        detail: {
          fields: Object.keys(fields),
          statusFrom: fields.status ? existing.status : undefined,
          statusTo: fields.status,
        },
      });
      res.json({ ok: true, entry: entryView({ ...entry, app_slug: existing.app_slug }) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/entries/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existing = await store.getEntryById(id);
      if (!existing) {
        res.status(404).json({ ok: false, error: 'entry_not_found', message: 'Unknown entry.' });
        return;
      }
      await store.deleteEntry(id);
      // Deletion is irreversible, so the trail keeps who was removed. Under
      // an erasure request, prefer the 'removed' status, which hides the
      // entry from counts while keeping the record intact.
      req.recordEvent({
        type: 'admin.entry_deleted',
        severity: 'warn',
        actor: 'admin',
        appId: Number(existing.app_id),
        entryId: id,
        message: `Entry #${existing.position} permanently deleted`,
        detail: { position: existing.position, emailKey: existing.email_key },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  /* ---------------- exports ---------------- */

  function resolveFormat(raw) {
    const format = String(raw ?? 'csv').toLowerCase();
    if (!Object.hasOwn(FORMATS, format)) {
      throw new ValidationError('format', 'format_invalid', `Format must be one of: ${Object.keys(FORMATS).join(', ')}.`);
    }
    return format;
  }

  router.get('/entries/export', rateLimit({ limiter: exportLimiter, name: 'admin-export' }), async (req, res, next) => {
    try {
      const format = resolveFormat(req.query.format);
      const includeMeta = req.query.include === 'meta';
      const columns = includeMeta ? [...BASE_EXPORT_COLUMNS, ...META_EXPORT_COLUMNS] : BASE_EXPORT_COLUMNS;

      const query = entryQuery(req);
      const rows = await store.listEntriesForExport({ ...query, limit: config.limits.maxExportRows });

      const appLabel = query.appId
        ? (await store.getAppById(query.appId))?.slug ?? 'app'
        : 'all-apps';
      const body = FORMATS[format].build(columns, rows, { sheetName: 'Waitlist', app: appLabel });
      const filename = exportFilename(`waitlist_${appLabel}`, format);

      req.log.info('entries exported', { format, rows: rows.length, appId: query.appId });
      req.recordEvent({
        type: 'admin.export',
        actor: 'admin',
        appId: query.appId,
        message: `Exported ${rows.length} entries as ${format.toUpperCase()}`,
        detail: { format, rows: rows.length, includeMeta, status: query.status, search: query.search || undefined },
      });

      sendDownload(res, body, FORMATS[format].contentType, filename);
    } catch (err) {
      next(err);
    }
  });

  /* ---------------- activity trail ---------------- */

  router.get('/events', async (req, res, next) => {
    try {
      const limit = intParam(req.query.limit, { min: 1, max: config.limits.maxPageSize, fallback: 100 });
      const offset = intParam(req.query.offset, { min: 0, max: 1_000_000, fallback: 0 });
      const { rows, total } = await store.listEvents({
        appId: req.query.appId ? Number(req.query.appId) : null,
        type: req.query.type ? searchTerm(req.query.type, 60) : null,
        severity: req.query.severity ? searchTerm(req.query.severity, 20) : null,
        search: searchTerm(req.query.search ?? ''),
        limit,
        offset,
      });
      res.json({
        ok: true,
        total,
        limit,
        offset,
        types: await store.distinctEventTypes(),
        events: rows.map((row) => ({
          id: Number(row.id),
          ts: row.ts,
          type: row.type,
          severity: row.severity,
          appSlug: row.app_slug,
          actor: row.actor,
          message: row.message,
          entryId: row.entry_id ? Number(row.entry_id) : null,
          requestId: row.request_id,
          ipHash: row.ip_hash,
          detail: safeParse(row.detail),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/events/export', rateLimit({ limiter: exportLimiter, name: 'admin-export' }), async (req, res, next) => {
    try {
      const format = resolveFormat(req.query.format);
      const { rows } = await store.listEvents({
        appId: req.query.appId ? Number(req.query.appId) : null,
        type: req.query.type ? searchTerm(req.query.type, 60) : null,
        severity: req.query.severity ? searchTerm(req.query.severity, 20) : null,
        search: searchTerm(req.query.search ?? ''),
        limit: config.limits.maxExportRows,
        offset: 0,
      });

      const body = FORMATS[format].build(EVENT_EXPORT_COLUMNS, rows, { sheetName: 'Activity' });
      const filename = exportFilename('activity-log', format);

      req.recordEvent({
        type: 'admin.export',
        actor: 'admin',
        message: `Exported ${rows.length} activity records as ${format.toUpperCase()}`,
        detail: { format, rows: rows.length, subject: 'events' },
      });

      sendDownload(res, body, FORMATS[format].contentType, filename);
    } catch (err) {
      next(err);
    }
  });

  router.stopLimiters = () => {
    loginLimiter.stop();
    apiLimiter.stop();
    exportLimiter.stop();
  };

  return router;
}

/**
 * Sends an export as an attachment.
 *
 * The filename is emitted twice: a plain ASCII fallback and RFC 5987
 * `filename*`, so a name containing non-ASCII survives older clients. The
 * value is already restricted to a safe character set by `exportFilename`,
 * which is what keeps a header-injection newline out of the response.
 */
function sendDownload(res, body, contentType, filename) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  res.setHeader('Cache-Control', 'no-store');
  // Downloads must not be sniffed into something executable.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(buffer);
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export default adminRoutes;

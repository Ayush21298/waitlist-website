/**
 * Public waitlist API.
 *
 * Multi-tenant by path: every route is scoped to an app slug, so a new
 * product gets its own frontend and its own numbering without any backend
 * change beyond a row in `apps`.
 *
 *   GET  /api/v1/apps/:slug            app metadata and current count
 *   GET  /api/v1/apps/:slug/count      count only, for the landing counter
 *   POST /api/v1/apps/:slug/waitlist   join the waitlist
 */
import express from 'express';

import { CapacityReachedError, DuplicateEntryError } from '../db/store.js';
import { rateLimit, SlidingWindowLimiter } from '../middleware/ratelimit.js';
import {
  clampMeta,
  validateEmail,
  validateName,
  validatePhone,
  validateSlug,
  ValidationError,
} from '../lib/validate.js';

export function publicRoutes({ config, store, logger }) {
  const router = express.Router();

  const signupLimiter = new SlidingWindowLimiter(config.rateLimit.signup);
  const readLimiter = new SlidingWindowLimiter(config.rateLimit.api);

  /** Resolves :slug to an active app, or ends the request with 404. */
  async function loadApp(req, res, next) {
    try {
      const slug = validateSlug(req.params.slug);
      const app = await store.getAppBySlug(slug);
      if (!app || Number(app.is_active) !== 1) {
        res.status(404).json({ ok: false, error: 'app_not_found', message: 'Unknown app.' });
        return;
      }
      req.app_ = app;
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * What a landing page is told about its own app.
   *
   * `capacity` and `remaining` exist because a limited beta advertises places
   * left rather than signups so far. A capacity of 0 means no limit, and
   * `remaining` is then null rather than a misleading negative number.
   */
  function publicAppView(app, count) {
    const capacity = Number(app.capacity) || 0;
    return {
      slug: app.slug,
      name: app.name,
      description: app.description,
      collectName: Number(app.collect_name) === 1,
      requireName: Number(app.require_name) === 1,
      collectPhone: Number(app.collect_phone) === 1,
      requirePhone: Number(app.require_phone) === 1,
      capacity,
      remaining: capacity > 0 ? Math.max(0, capacity - count) : null,
      count,
    };
  }

  /**
   * Every app on this deployment, for the front door.
   *
   * Driven from the database rather than a list in the page, so adding an app
   * makes it appear on the index with no edit anywhere. Inactive apps are
   * left out: deactivating one should take it off the front door.
   */
  router.get('/apps', rateLimit({ limiter: readLimiter, name: 'api-read' }), async (req, res, next) => {
    try {
      const apps = await store.listApps({ includeInactive: false });
      const views = await Promise.all(
        apps.map(async (app) => publicAppView(app, await store.countEntries(app.id))),
      );
      res.json({ ok: true, apps: views });
    } catch (err) {
      next(err);
    }
  });

  router.get('/apps/:slug', rateLimit({ limiter: readLimiter, name: 'api-read' }), loadApp, async (req, res, next) => {
    try {
      const count = await store.countEntries(req.app_.id);
      res.json({ ok: true, app: publicAppView(req.app_, count) });
    } catch (err) {
      next(err);
    }
  });

  router.get(
    '/apps/:slug/count',
    rateLimit({ limiter: readLimiter, name: 'api-read' }),
    loadApp,
    async (req, res, next) => {
      try {
        const count = await store.countEntries(req.app_.id);
        const capacity = Number(req.app_.capacity) || 0;
        res.json({
          ok: true,
          count,
          capacity,
          remaining: capacity > 0 ? Math.max(0, capacity - count) : null,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/apps/:slug/waitlist',
    rateLimit({ limiter: signupLimiter, name: 'signup' }),
    loadApp,
    async (req, res, next) => {
      const app = req.app_;
      const body = req.body ?? {};

      try {
        // Honeypot. The field is hidden from users and invisible to screen
        // readers, so anything filled in came from a bot. Answer exactly as a
        // success looks, store nothing, and record it: telling a bot it
        // failed only teaches it to try again differently.
        if (typeof body.website === 'string' && body.website.trim() !== '') {
          const count = await store.countEntries(app.id);
          req.log.warn('honeypot triggered', { app: app.slug });
          req.recordEvent({
            type: 'signup.honeypot',
            severity: 'warn',
            appId: app.id,
            message: 'Honeypot field was filled; submission discarded',
            detail: { app: app.slug },
          });
          res.status(200).json({ ok: true, position: count + 1, total: count + 1 });
          return;
        }

        // Whether a name is wanted at all, and whether it is mandatory, are
        // properties of the app rather than of the platform.
        const collectsName = Number(app.collect_name) === 1;
        const name = collectsName
          ? validateName(body.name, {
              maxLength: config.limits.maxNameLength,
              required: Number(app.require_name) === 1,
            })
          : '';
        const email = validateEmail(body.email, { maxLength: config.limits.maxEmailLength });

        // Same rule as the name: an app that declares it does not collect a
        // phone number must not end up storing one just because somebody
        // posted it. Anything else quietly accumulates personal data the app
        // says it never asks for, and it would show up in exports.
        const collectsPhone = Number(app.collect_phone) === 1;
        const phone = collectsPhone
          ? validatePhone(body.phone, {
              required: Number(app.require_phone) === 1,
              maxLength: config.limits.maxPhoneLength,
            })
          : { value: '', normalized: '' };

        // A durable backstop beneath the in-memory limiter: this one survives
        // a process restart, so an attacker cannot reset it by waiting for a
        // redeploy.
        const recent = await store.countRecentSignups({
          ipHash: req.ipHash,
          windowMs: config.rateLimit.signup.windowMs,
        });
        if (recent >= config.rateLimit.signup.max) {
          req.log.warn('signup blocked by durable limit', { app: app.slug, recent });
          req.recordEvent({
            type: 'ratelimit.signup_blocked',
            severity: 'warn',
            appId: app.id,
            message: 'Signup blocked: too many recent signups from this address',
            detail: { recent },
          });
          res.status(429).json({
            ok: false,
            error: 'rate_limited',
            message: 'Too many signups from this network. Please try again later.',
          });
          return;
        }

        const entry = await store.createEntry({
          appId: app.id,
          name,
          email: email.value,
          emailKey: email.normalized,
          phone: phone.value,
          phoneKey: phone.normalized,
          // Metadata is attacker-controlled: clamped, stored, never interpreted.
          locale: clampMeta(body.locale ?? req.get('accept-language') ?? '', 32),
          source: clampMeta(body.source ?? '', 200),
          referrer: clampMeta(req.get('referer') ?? '', 200),
          // Taken from the header, never from the body, so it cannot be spoofed
          // independently of the connection that made the request.
          userAgent: clampMeta(req.get('user-agent') ?? '', 300),
          ipHash: req.ipHash,
          capacity: Number(app.capacity) || 0,
        });

        const total = await store.countEntries(app.id);
        const capacity = Number(app.capacity) || 0;

        req.log.info('signup accepted', { app: app.slug, entryId: entry.id, position: entry.position });
        req.recordEvent({
          type: 'signup.created',
          appId: app.id,
          entryId: entry.id,
          message: `Joined the ${app.name} waitlist at position ${entry.position}`,
          detail: { position: entry.position, hasPhone: Boolean(phone.value), source: entry.source },
        });

        res.status(201).json({
          ok: true,
          position: entry.position,
          total,
          capacity,
          remaining: capacity > 0 ? Math.max(0, capacity - total) : null,
          duplicate: false,
        });
      } catch (err) {
        if (err instanceof CapacityReachedError) {
          const total = await store.countEntries(app.id).catch(() => err.capacity);
          req.log.info('signup refused: app is full', { app: app.slug, capacity: err.capacity });
          req.recordEvent({
            type: 'signup.full',
            severity: 'warn',
            appId: app.id,
            message: `Signup refused: ${app.name} has filled all ${err.capacity} places`,
            detail: { capacity: err.capacity },
          });
          res.status(409).json({
            ok: false,
            error: 'full',
            message: 'This beta is full. Thank you for your interest.',
            total,
            capacity: err.capacity,
            remaining: 0,
          });
          return;
        }
        if (err instanceof DuplicateEntryError) {
          // Returning the original position is friendlier than an error and
          // leaks nothing: the caller just supplied this address themselves.
          const total = await store.countEntries(app.id).catch(() => null);
          req.log.info('duplicate signup', { app: app.slug, position: err.existing.position });
          req.recordEvent({
            type: 'signup.duplicate',
            appId: app.id,
            entryId: err.existing.id,
            message: 'Repeat signup with an address already on the list',
            detail: { position: err.existing.position },
          });
          res.status(200).json({
            ok: true,
            position: err.existing.position,
            total,
            duplicate: true,
            message: 'You are already on the waitlist.',
          });
          return;
        }

        if (err instanceof ValidationError) {
          req.recordEvent({
            type: 'signup.rejected',
            severity: 'warn',
            appId: app.id,
            message: `Signup rejected: ${err.code}`,
            detail: { field: err.field, code: err.code },
          });
        }
        next(err);
      }
    },
  );

  router.stopLimiters = () => {
    signupLimiter.stop();
    readLimiter.stop();
  };

  return router;
}

export default publicRoutes;

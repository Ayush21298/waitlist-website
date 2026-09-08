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

import { DuplicateEntryError } from '../db/store.js';
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

  function publicAppView(app, count) {
    return {
      slug: app.slug,
      name: app.name,
      description: app.description,
      collectPhone: Number(app.collect_phone) === 1,
      requirePhone: Number(app.require_phone) === 1,
      count,
    };
  }

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
        res.json({ ok: true, count });
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

        const name = validateName(body.name, { maxLength: config.limits.maxNameLength });
        const email = validateEmail(body.email, { maxLength: config.limits.maxEmailLength });
        const phone = validatePhone(body.phone, {
          required: Number(app.require_phone) === 1,
          maxLength: config.limits.maxPhoneLength,
        });

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
        });

        const total = await store.countEntries(app.id);

        req.log.info('signup accepted', { app: app.slug, entryId: entry.id, position: entry.position });
        req.recordEvent({
          type: 'signup.created',
          appId: app.id,
          entryId: entry.id,
          message: `Joined the ${app.name} waitlist at position ${entry.position}`,
          detail: { position: entry.position, hasPhone: Boolean(phone.value), source: entry.source },
        });

        res.status(201).json({ ok: true, position: entry.position, total, duplicate: false });
      } catch (err) {
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

/**
 * Site access gate.
 *
 * The outer perimeter: without a gate session, no page and no API on this
 * deployment returns anything but the login screen. Holding the link is not
 * enough.
 *
 *   GET  /api/v1/gate/status
 *   POST /api/v1/gate/login
 *   POST /api/v1/gate/logout
 */
import express from 'express';

import { rateLimit, SlidingWindowLimiter } from '../middleware/ratelimit.js';

export function gateRoutes({ config, store, auth, logger }) {
  const router = express.Router();
  const loginLimiter = new SlidingWindowLimiter(config.rateLimit.login);

  router.get('/status', (req, res) => {
    res.json({
      ok: true,
      enabled: config.auth.siteGateEnabled,
      authenticated: Boolean(req.gateSession),
    });
  });

  router.post('/login', rateLimit({ limiter: loginLimiter, name: 'gate-login' }), async (req, res, next) => {
    try {
      if (!config.auth.siteGateEnabled) {
        res.json({ ok: true, alreadyOpen: true });
        return;
      }

      const password = typeof req.body?.password === 'string' ? req.body.password : '';

      const lockout = await auth.lockoutStatus('gate', req.ipHash);
      if (lockout.locked) {
        const retryAfterSeconds = Math.ceil(lockout.retryAfterMs / 1000);
        res.setHeader('Retry-After', String(retryAfterSeconds));
        req.log.warn('gate login locked out', { failures: lockout.failures, retryAfterSeconds });
        req.recordEvent({
          type: 'gate.locked_out',
          severity: 'warn',
          message: 'Gate login temporarily locked after repeated failures',
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

      const valid = await auth.verifyPasswordFor('gate', password);
      await store.recordAuthAttempt({ kind: 'gate', ipHash: req.ipHash, success: valid, requestId: req.id });

      if (!valid) {
        req.log.warn('gate login failed');
        req.recordEvent({
          type: 'gate.login_failed',
          severity: 'warn',
          message: 'Incorrect site access password',
        });
        // One message for every failure mode; nothing here reveals whether a
        // password was close, or how long the real one is.
        res.status(401).json({ ok: false, error: 'invalid_password', message: 'Incorrect password.' });
        return;
      }

      // A correct password clears the burst budget, so a legitimate visitor
      // who mistyped a few times is not left throttled.
      loginLimiter.reset(req.ipHash);

      const session = await auth.createSession('gate', req, res);
      req.log.info('gate login succeeded', { sessionId: session.id });
      req.recordEvent({ type: 'gate.login', message: 'Site access granted', detail: { sessionId: session.id } });

      res.json({ ok: true, expiresAt: session.expiresAt });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const sessionId = req.gateSession?.id ?? null;
      await auth.revokeSession('gate', req, res);
      if (sessionId) {
        logger.info('gate logout', { sessionId });
        req.recordEvent({ type: 'gate.logout', message: 'Site access session ended', detail: { sessionId } });
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.stopLimiters = () => loginLimiter.stop();
  return router;
}

export default gateRoutes;

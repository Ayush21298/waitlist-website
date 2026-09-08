/**
 * Health and readiness probes.
 *
 * Deliberately outside the site gate: a platform health checker cannot log
 * in, and a probe that requires a password is a probe that reports the
 * service as down. They are also the one place that must stay cheap, since
 * free-tier platforms poll them continuously.
 *
 * Neither endpoint reveals anything an attacker can use: no versions, no
 * hostnames, no connection strings, no counts.
 */
import express from 'express';

export function healthRoutes({ store, logger, startedAt }) {
  const router = express.Router();

  // Liveness: is the process up and serving? No I/O, so a slow database
  // cannot cause the platform to restart an otherwise healthy instance.
  router.get('/healthz', (req, res) => {
    res.json({ ok: true, status: 'alive', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
  });

  // Readiness: can it actually serve requests, database included?
  router.get('/readyz', async (req, res) => {
    try {
      const healthy = await store.healthCheck();
      if (!healthy) throw new Error('database health check returned false');
      res.json({ ok: true, status: 'ready' });
    } catch (err) {
      logger.error('readiness check failed', { err });
      res.status(503).json({ ok: false, status: 'not_ready' });
    }
  });

  return router;
}

export default healthRoutes;

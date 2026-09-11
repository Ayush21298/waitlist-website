/**
 * Express application assembly.
 *
 * Middleware order is load-bearing and reads top to bottom as the path a
 * request actually takes: identify it, harden the response, parse it,
 * authenticate it, route it.
 */
import path from 'node:path';

import express from 'express';

import { adminRoutes } from './routes/admin.js';
import { attachSessions, cookieParser, requireGate } from './middleware/auth.js';
import { cors, sameOriginOnly, securityHeaders } from './middleware/security.js';
import { errorHandler, eventRecorder, notFound } from './middleware/errors.js';
import { gateRoutes } from './routes/gate.js';
import { healthRoutes } from './routes/health.js';
import { publicRoutes } from './routes/public.js';
import { requestContext } from './middleware/context.js';
import { AssetCache, compressedStatic, resolveWithin, sendAsset } from './middleware/static.js';

export function createApp({ config, store, auth, logger, startedAt = Date.now() }) {
  const app = express();

  // Trust exactly as many proxy hops as are actually in front of us. A
  // blanket `true` would let any client forge X-Forwarded-For and so forge
  // the identity every rate limit and lockout is keyed on.
  app.set('trust proxy', config.server.trustProxyHops);
  app.set('x-powered-by', false);
  app.set('etag', false);
  // The 'extended' parser accepts deeply nested bracket syntax that has been
  // a repeated source of prototype-pollution and denial-of-service reports.
  // Nothing here needs it.
  app.set('query parser', 'simple');

  app.use(requestContext(config, logger));
  app.use(securityHeaders(config));
  app.use(cors(config));
  app.use(cookieParser());
  app.use(eventRecorder(store, logger));

  app.use(
    express.json({
      limit: config.server.bodyLimitBytes,
      // application/json only. text/plain would also parse, but accepting it
      // lets a browser send a cross-origin POST as a "simple request" with no
      // preflight -- the origin check would still refuse it, but requiring
      // JSON means the browser refuses it first, one layer earlier.
      type: 'application/json',
    }),
  );

  app.use(sameOriginOnly(config));
  app.use(attachSessions(auth, config));

  // Probes answer before the gate: a platform health checker cannot log in.
  app.use(healthRoutes({ store, logger, startedAt }));

  // The gate's own API must be reachable without a gate session.
  const gate = gateRoutes({ config, store, auth, logger });
  app.use('/api/v1/gate', gate);

  const frontend = config.paths.frontendDir;
  // Assets are versioned by deploy, not by name, so the cache window is kept
  // short: a stale page must never mask a password change.
  const maxAgeSeconds = config.isProduction ? 300 : 0;
  const assetCache = new AssetCache();

  /** Serves one known page through the same compressing, caching path. */
  function sendPage(req, res, next, ...segments) {
    const file = path.join(frontend, ...segments);
    const target = resolveWithin(frontend, `/${segments.join('/')}`);
    if (!target) {
      next(new Error(`missing frontend asset: ${file}`));
      return;
    }
    sendAsset(req, res, target.file, target.stat, { cache: assetCache, maxAgeSeconds, logger }).catch(next);
  }

  // The gate page is the only unauthenticated UI.
  app.get('/gate', (req, res, next) => {
    if (req.gateSession) {
      res.redirect(302, safeRedirect(req.query.next));
      return;
    }
    sendPage(req, res, next, 'gate', 'index.html');
  });

  // ---- everything below requires a gate session ----
  app.use(requireGate(config));

  const publicApi = publicRoutes({ config, store, logger });
  app.use('/api/v1', publicApi);

  const admin = adminRoutes({ config, store, auth, logger });
  app.use('/api/v1/admin', admin);

  // The admin panel is behind the gate but ahead of the admin password; the
  // page itself decides which of its two views to show.
  app.get(['/admin', '/admin/', '/admin/login'], (req, res, next) => {
    sendPage(req, res, next, 'admin', 'index.html');
  });

  app.use('/admin', compressedStatic({ root: path.join(frontend, 'admin'), maxAgeSeconds, cache: assetCache, logger }));
  app.use('/shared', compressedStatic({ root: path.join(frontend, 'shared'), maxAgeSeconds, cache: assetCache, logger }));

  // Each app's frontend is served at /a/<slug>/. Serving them under one
  // prefix keeps every tenant same-origin with the API, so cookies and CSRF
  // work without any cross-origin configuration.
  app.use(
    '/a',
    compressedStatic({
      root: path.join(frontend, 'apps'),
      index: 'index.html',
      maxAgeSeconds,
      cache: assetCache,
      logger,
    }),
  );

  // The front door: an index of every app on this deployment. It used to
  // redirect straight to one app, which made the other ones unreachable
  // unless you already knew their URL.
  app.get('/', (req, res, next) => {
    sendPage(req, res, next, 'home', 'index.html');
  });

  app.use(notFound());
  app.use(errorHandler(logger));

  /** Releases the interval timers held by the rate limiters. */
  app.stopBackgroundWork = () => {
    gate.stopLimiters?.();
    publicApi.stopLimiters?.();
    admin.stopLimiters?.();
  };

  return app;
}

/**
 * Restricts the post-login redirect to a same-site path.
 *
 * Without this, `/gate?next=https://evil.example` turns the gate into an open
 * redirect: a credible phishing link on a domain the victim trusts.
 */
export function safeRedirect(next) {
  if (typeof next !== 'string' || !next) return '/';
  // Must be a single-slash-rooted path. This rejects `//evil.example`
  // (protocol-relative) and `https://evil.example` alike.
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  if (next.includes('\\') || /[\r\n]/.test(next)) return '/';
  return next;
}

export default createApp;

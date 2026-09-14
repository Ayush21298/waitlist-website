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

  /**
   * The whole site is built on a router rather than directly on the app, so
   * it can be mounted under a sub-path such as /r2p/waitlist.
   *
   * Express rewrites req.url for a mounted router, which means every route,
   * every static mount and every path-traversal check keeps working unchanged
   * -- they all see paths relative to the mount. Only the places that build
   * an *absolute* path for the client to follow need to know the prefix:
   * redirects, the cookie Path, and the URLs baked into the pages.
   */
  const site = express.Router();
  const basePath = config.basePath;

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

  site.use(requestContext(config, logger));
  site.use(securityHeaders(config));
  site.use(cors(config));
  site.use(cookieParser());
  site.use(eventRecorder(store, logger));

  site.use(
    express.json({
      limit: config.server.bodyLimitBytes,
      // application/json only. text/plain would also parse, but accepting it
      // lets a browser send a cross-origin POST as a "simple request" with no
      // preflight -- the origin check would still refuse it, but requiring
      // JSON means the browser refuses it first, one layer earlier.
      type: 'application/json',
    }),
  );

  site.use(sameOriginOnly(config));
  site.use(attachSessions(auth, config));

  // Probes answer before the gate: a platform health checker cannot log in.
  site.use(healthRoutes({ store, logger, startedAt }));

  // The gate's own API must be reachable without a gate session.
  const gate = gateRoutes({ config, store, auth, logger });
  site.use('/api/v1/gate', gate);

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
  site.get('/gate', (req, res, next) => {
    if (req.gateSession) {
      res.redirect(302, safeRedirect(req.query.next, basePath));
      return;
    }
    sendPage(req, res, next, 'gate', 'index.html');
  });

  // ---- everything below requires a gate session ----
  site.use(requireGate(config));

  const publicApi = publicRoutes({ config, store, logger });
  site.use('/api/v1', publicApi);

  const admin = adminRoutes({ config, store, auth, logger });
  site.use('/api/v1/admin', admin);

  // The admin panel is behind the gate but ahead of the admin password; the
  // page itself decides which of its two views to show.
  site.get(['/admin', '/admin/', '/admin/login'], (req, res, next) => {
    sendPage(req, res, next, 'admin', 'index.html');
  });

  site.use('/admin', compressedStatic({ root: path.join(frontend, 'admin'), maxAgeSeconds, cache: assetCache, logger }));
  site.use('/shared', compressedStatic({ root: path.join(frontend, 'shared'), maxAgeSeconds, cache: assetCache, logger }));

  // Each app's frontend is served at /a/<slug>/. Serving them under one
  // prefix keeps every tenant same-origin with the API, so cookies and CSRF
  // work without any cross-origin configuration.
  site.use(
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
  site.get('/', (req, res, next) => {
    sendPage(req, res, next, 'home', 'index.html');
  });

  site.use(notFound());
  site.use(errorHandler(logger));

  if (basePath) {
    // Someone given the prefix without its trailing slash should still land
    // on the site rather than a 404, and relative assets on the index need
    // the trailing slash to resolve.
    // Express treats a path and its trailing-slash form as the same route, so
    // matching `basePath` alone also matched `${basePath}/` and redirected it
    // to itself -- an infinite loop for anyone who typed the URL correctly.
    // The originalUrl check distinguishes the two.
    app.get(basePath, (req, res, next) => {
      const [pathOnly] = (req.originalUrl || '').split('?');
      if (pathOnly.endsWith('/')) return next();
      const query = req.originalUrl.includes('?')
        ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
        : '';
      res.redirect(301, `${basePath}/${query}`);
    });
    app.use(basePath, site);
    // Anything outside the prefix is not ours. A bare 404 is the honest
    // answer: this deployment does not own the rest of the origin.
    app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('404 Not Found'));
  } else {
    app.use(site);
  }

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
export function safeRedirect(next, basePath = '') {
  const home = `${basePath}/`;
  if (typeof next !== 'string' || !next) return home;
  // Must be a single-slash-rooted path. This rejects `//evil.example`
  // (protocol-relative) and `https://evil.example` alike.
  if (!next.startsWith('/') || next.startsWith('//')) return home;
  if (next.includes('\\') || /[\r\n]/.test(next)) return home;
  // Under a prefix, only destinations inside it are ours to redirect to.
  // Without this the gate would happily bounce a visitor to any path on the
  // origin, which on a shared host is somebody else's site.
  if (basePath && next !== basePath && !next.startsWith(`${basePath}/`)) return home;
  return next;
}

export default createApp;

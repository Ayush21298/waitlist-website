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
      // The landing page posts as text/plain to dodge a CORS preflight, a
      // habit inherited from Apps Script endpoints. Both are parsed as JSON;
      // the origin check is what actually protects these routes.
      type: ['application/json', 'text/plain'],
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
  const staticOptions = {
    // Assets are versioned by deploy, not by name; a short cache keeps a
    // password change from being masked by a stale page.
    maxAge: config.isProduction ? '5m' : 0,
    etag: true,
    index: false,
    redirect: false,
    dotfiles: 'ignore',
  };

  // The gate page and its assets are the only unauthenticated UI.
  app.get('/gate', (req, res) => {
    if (req.gateSession) {
      res.redirect(302, safeRedirect(req.query.next));
      return;
    }
    res.sendFile(path.join(frontend, 'gate', 'index.html'));
  });

  // ---- everything below requires a gate session ----
  app.use(requireGate(config));

  const publicApi = publicRoutes({ config, store, logger });
  app.use('/api/v1', publicApi);

  const admin = adminRoutes({ config, store, auth, logger });
  app.use('/api/v1/admin', admin);

  // The admin login page is behind the gate but ahead of the admin password.
  app.get(['/admin', '/admin/'], (req, res) => {
    res.sendFile(path.join(frontend, 'admin', 'index.html'));
  });
  app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(frontend, 'admin', 'index.html'));
  });

  app.use('/admin', express.static(path.join(frontend, 'admin'), staticOptions));
  app.use('/shared', express.static(path.join(frontend, 'shared'), staticOptions));

  // Each app's frontend is served at /a/<slug>/. Serving them under one
  // prefix keeps every tenant same-origin with the API, so cookies and CSRF
  // work without any cross-origin configuration.
  app.use('/a', express.static(path.join(frontend, 'apps'), { ...staticOptions, index: 'index.html' }));

  // The root redirects to the default app so the deployment has a front door.
  app.get('/', (req, res) => {
    res.redirect(302, `/a/${config.apps.defaultSlug}/`);
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

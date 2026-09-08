/**
 * Security headers, CORS and same-origin enforcement.
 *
 * Written out rather than pulled from a helmet-style dependency: the policy
 * below is short, and for a service holding contact details it is worth being
 * able to read the exact headers being sent without chasing a package's
 * defaults across a version bump.
 */

/**
 * Content Security Policy.
 *
 * The landing page inlines its styles and its script, and pulls a webfont
 * stylesheet from jsDelivr, so 'unsafe-inline' is required for style-src and
 * script-src. Everything else is closed:
 *
 *   - default-src 'none' means anything not named below is refused.
 *   - frame-ancestors 'none' blocks clickjacking, including of the admin panel.
 *   - form-action 'self' stops an injected form from posting the waitlist
 *     elsewhere.
 *   - base-uri 'none' prevents a <base> tag from re-pointing relative URLs.
 *   - object-src 'none' removes the plugin attack surface entirely.
 */
function buildCsp() {
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "font-src 'self' data: https://cdn.jsdelivr.net",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function securityHeaders(config) {
  const csp = buildCsp();

  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // No part of this service needs a camera, a microphone or a location.
    res.setHeader(
      'Permissions-Policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    );
    // Express advertises itself by default; there is no reason to tell an
    // attacker which stack to target.
    res.removeHeader('X-Powered-By');

    if (config.isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // Nothing behind the gate should ever be cached by a shared proxy.
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
    }

    next();
  };
}

/**
 * CORS.
 *
 * The intended deployment serves the frontends and the API from one origin,
 * so cross-origin requests are refused unless an origin is explicitly
 * allow-listed. There is no wildcard path: credentials are cookies, and
 * `Access-Control-Allow-Origin: *` cannot carry them anyway.
 */
export function cors(config) {
  const allowed = new Set(config.cors.allowedOrigins);

  return function corsMiddleware(req, res, next) {
    const origin = req.get('origin');

    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Request-Id');
      res.setHeader('Access-Control-Max-Age', '600');
      // Caches must not serve one origin's response to another.
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      res.status(origin && !allowed.has(origin) ? 403 : 204).end();
      return;
    }

    next();
  };
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Origin check for state-changing requests.
 *
 * SameSite cookies are the primary CSRF defence and the admin API also
 * requires a session-bound token, but neither covers login itself: a
 * cross-site POST to the gate can otherwise log a victim into an attacker's
 * session. Comparing Origin (falling back to Referer) against the request's
 * own host closes that, and costs nothing.
 */
export function sameOriginOnly(config) {
  const allowed = new Set(config.cors.allowedOrigins);

  return function sameOriginMiddleware(req, res, next) {
    if (!STATE_CHANGING.has(req.method)) return next();

    const origin = req.get('origin') ?? refererOrigin(req.get('referer'));
    if (!origin) {
      // Some privacy tools strip both headers. Cookies are SameSite, so a
      // cross-site request would not carry a session in the first place;
      // record it and let the session check decide.
      req.log?.debug('request without origin or referer', { method: req.method, path: req.path });
      return next();
    }

    const expected = `${req.protocol}://${req.get('host')}`;
    if (origin === expected || allowed.has(origin)) return next();

    req.log?.warn('cross-origin request refused', { method: req.method, path: req.path, origin, expected });
    res.status(403).json({ ok: false, error: 'cross_origin_refused', message: 'Request origin is not allowed.' });
  };
}

function refererOrigin(referer) {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export default { securityHeaders, cors, sameOriginOnly };

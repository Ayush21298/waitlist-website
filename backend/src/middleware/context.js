/**
 * Per-request context and access logging.
 *
 * Attaches a correlation id, a pseudonymised client identity and a scoped
 * logger to every request, then records one structured line when the response
 * finishes. Everything downstream logs through `req.log`, so every line for a
 * given request shares a request id and can be pulled out of the log with a
 * single filter.
 */
import { keyedHash, shortId } from '../lib/crypto.js';

/** Header a client may send to correlate its own traces; validated, not trusted. */
const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function requestContext(config, logger) {
  return function requestContextMiddleware(req, res, next) {
    const started = process.hrtime.bigint();

    // Reuse a caller-supplied id only if it is well-formed, so a hostile
    // value cannot inject newlines or bulk into the log.
    const supplied = req.get(REQUEST_ID_HEADER);
    req.id = supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : shortId();
    res.setHeader('X-Request-Id', req.id);

    // req.ip already respects the configured proxy hop count; see app.js.
    req.clientIp = req.ip || req.socket?.remoteAddress || '';
    req.ipHash = keyedHash(req.clientIp, config.auth.ipHashSecret);
    req.uaHash = keyedHash(req.get('user-agent') ?? '', config.auth.ipHashSecret);

    req.log = logger.child({ requestId: req.id, ipHash: req.ipHash });

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      req.log.log(level, 'http request', {
        method: req.method,
        // The routed path, not the raw URL: query strings can carry personal
        // data and the route is what aggregates usefully.
        path: req.path,
        route: req.route?.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        bytes: Number(res.getHeader('content-length')) || 0,
        uaHash: req.uaHash,
        referer: normaliseReferer(req.get('referer')),
        gateSession: req.gateSession?.id ?? null,
        adminSession: req.adminSession?.id ?? null,
      });
    });

    next();
  };
}

/** Keeps only the origin and path of a referer; strips query and fragment. */
function normaliseReferer(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 200);
  } catch {
    return '';
  }
}

export default requestContext;

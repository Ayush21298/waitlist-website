/**
 * Error handling, not-found handling, and the per-request event recorder.
 *
 * The guiding rule: an internal failure produces a logged, correlated,
 * detailed record on the server and an opaque message to the client. Stack
 * traces, SQL text and file paths are exactly the reconnaissance an attacker
 * wants, and they help a legitimate user not at all.
 */
import { ValidationError } from '../lib/validate.js';
import { DuplicateEntryError } from '../db/store.js';

/**
 * Gives every request a fire-and-forget `recordEvent` that writes to the
 * activity trail with the request's correlation id already filled in.
 *
 * Deliberately not awaited by callers: an events write must never fail the
 * request that triggered it, nor add latency to a signup.
 */
export function eventRecorder(store, logger) {
  return function eventRecorderMiddleware(req, res, next) {
    req.recordEvent = (event) => {
      const payload = {
        actor: req.adminSession ? 'admin' : 'public',
        requestId: req.id,
        ipHash: req.ipHash,
        ...event,
      };
      Promise.resolve()
        .then(() => store.recordEvent(payload))
        .catch((err) => logger.error('failed to record event', { err, type: payload.type }));
    };
    next();
  };
}

export function notFound() {
  return function notFoundMiddleware(req, res) {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ ok: false, error: 'not_found', message: 'No such endpoint.' });
      return;
    }
    res.status(404).type('text/plain; charset=utf-8').send('404 Not Found');
  };
}

/** Errors that carry a safe, user-facing message and a known status. */
function classify(err) {
  if (err instanceof ValidationError) {
    return { status: 400, error: err.code, message: err.message, field: err.field };
  }
  if (err instanceof DuplicateEntryError) {
    return { status: 409, error: err.code, message: err.message };
  }
  if (err?.type === 'entity.too.large') {
    return { status: 413, error: 'payload_too_large', message: 'Request body is too large.' };
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return { status: 400, error: 'invalid_json', message: 'Request body is not valid JSON.' };
  }
  if (err?.status && err.status >= 400 && err.status < 500 && err.expose) {
    return { status: err.status, error: err.code ?? 'bad_request', message: err.message };
  }
  return null;
}

export function errorHandler(logger) {
  // Express identifies an error handler by arity, so `next` must stay.
  // eslint-disable-next-line no-unused-vars
  return function errorHandlerMiddleware(err, req, res, next) {
    const known = classify(err);

    if (known) {
      req.log?.warn('request rejected', {
        error: known.error,
        status: known.status,
        path: req.path,
        method: req.method,
      });
      if (!res.headersSent) {
        res.status(known.status).json({ ok: false, ...known, status: undefined });
      }
      return;
    }

    // Unexpected: log everything, disclose nothing.
    (req.log ?? logger).error('unhandled request error', {
      err,
      path: req.path,
      method: req.method,
    });
    req.recordEvent?.({
      type: 'server.error',
      severity: 'error',
      message: 'Unhandled request error',
      detail: { path: req.path, method: req.method, name: err?.name, code: err?.code },
    });

    if (res.headersSent) {
      // Headers are already on the wire; all that is left is to stop cleanly
      // rather than emit a half-written body.
      res.destroy();
      return;
    }

    res.status(500).json({
      ok: false,
      error: 'internal_error',
      message: 'Something went wrong on our side. Please try again.',
      // Safe to expose and the only thing that makes a support report useful.
      requestId: req.id,
    });
  };
}

export default { eventRecorder, notFound, errorHandler };

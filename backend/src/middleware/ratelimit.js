/**
 * Rate limiting.
 *
 * Two layers, because they defend against different things:
 *
 *   - A per-process sliding window, held in memory. Cheap enough to run on
 *     every request, and it absorbs bursts and accidental request loops.
 *   - A database-backed lockout for password attempts, in `auth.js`. That one
 *     has to survive a restart, or an attacker resets their budget by waiting
 *     for the platform to recycle the process.
 *
 * The in-memory window is per-instance. On a single deployment that is exact;
 * across replicas the effective limit multiplies by the replica count, which
 * is noted in the deployment guide.
 */

/**
 * Sliding window over timestamps, keyed by client.
 *
 * Timestamps are stored rather than a plain counter so the window slides
 * smoothly. A fixed window lets a caller spend its whole budget at the end of
 * one window and again at the start of the next, doubling the intended rate
 * right at the boundary.
 */
export class SlidingWindowLimiter {
  #windowMs;
  #max;
  #hits = new Map();
  #sweepTimer = null;

  constructor({ windowMs, max, sweepIntervalMs = 60_000 }) {
    this.#windowMs = windowMs;
    this.#max = max;

    // Without a sweep, one request per unique address would grow the map
    // without bound. Unref'd so it never keeps the process alive.
    this.#sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    if (typeof this.#sweepTimer.unref === 'function') this.#sweepTimer.unref();
  }

  /** @returns {{allowed: boolean, remaining: number, retryAfterMs: number}} */
  check(key) {
    const now = Date.now();
    const cutoff = now - this.#windowMs;

    const timestamps = this.#hits.get(key) ?? [];
    // Entries are appended in order, so dropping the expired prefix is enough.
    let firstFresh = 0;
    while (firstFresh < timestamps.length && timestamps[firstFresh] <= cutoff) firstFresh += 1;
    const fresh = firstFresh ? timestamps.slice(firstFresh) : timestamps;

    if (fresh.length >= this.#max) {
      this.#hits.set(key, fresh);
      const retryAfterMs = Math.max(0, fresh[0] + this.#windowMs - now);
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    fresh.push(now);
    this.#hits.set(key, fresh);
    return { allowed: true, remaining: this.#max - fresh.length, retryAfterMs: 0 };
  }

  /** Drops a client's history, e.g. after a successful login. */
  reset(key) {
    this.#hits.delete(key);
  }

  sweep() {
    const cutoff = Date.now() - this.#windowMs;
    for (const [key, timestamps] of this.#hits) {
      if (!timestamps.length || timestamps[timestamps.length - 1] <= cutoff) this.#hits.delete(key);
    }
  }

  get size() {
    return this.#hits.size;
  }

  stop() {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
  }
}

/**
 * Express middleware wrapping a limiter.
 *
 * @param {object} options
 * @param {SlidingWindowLimiter} options.limiter
 * @param {string} options.name        appears in logs and events
 * @param {(req: any) => string} [options.keyFn]
 */
export function rateLimit({ limiter, name, keyFn = (req) => req.ipHash }) {
  return function rateLimitMiddleware(req, res, next) {
    const key = keyFn(req);
    const result = limiter.check(key);

    if (result.allowed) {
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      return next();
    }

    const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(retryAfterSeconds));

    req.log?.warn('rate limit exceeded', { limiter: name, path: req.path, retryAfterSeconds });
    req.recordEvent?.({
      type: 'ratelimit.blocked',
      severity: 'warn',
      message: `Rate limit "${name}" exceeded`,
      detail: { path: req.path, method: req.method, retryAfterSeconds },
    });

    res.status(429).json({
      ok: false,
      error: 'rate_limited',
      message: 'Too many requests. Please wait a moment and try again.',
      retryAfterSeconds,
    });
  };
}

export default { SlidingWindowLimiter, rateLimit };

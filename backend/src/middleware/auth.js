/**
 * Authentication: the site gate, the admin panel, sessions and CSRF.
 *
 * Two independent perimeters, deliberately not one:
 *
 *   - The site gate stands in front of everything a visitor can reach, so a
 *     leaked link alone opens nothing.
 *   - The admin panel sits behind its own, stronger password on top of that.
 *
 * Neither password is stored anywhere. At boot each is turned into a scrypt
 * hash held in memory; the plaintext exists only in the environment. Session
 * tokens are random 256-bit values of which only a SHA-256 digest is
 * persisted, so a database leak yields nothing that can be replayed.
 */
import crypto from 'node:crypto';

import { csrfToken as newCsrfToken, hashPassword, randomToken, shortId, tokenDigest, verifyPassword } from '../lib/crypto.js';

export const GATE_COOKIE = 'wl_gate';
export const ADMIN_COOKIE = 'wl_admin';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** last_seen_at is only rewritten this often, to keep sessions off the write path. */
const TOUCH_INTERVAL_MS = 60_000;

/* ---------------------------------------------------------------- *
 * Cookies
 * ---------------------------------------------------------------- */

/** Minimal, allocation-light cookie header parser. */
export function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (!key || key in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function cookieParser() {
  return function cookieParserMiddleware(req, res, next) {
    req.cookies = parseCookies(req.headers.cookie);
    next();
  };
}

function serialiseCookie(name, value, { maxAgeMs, secure, sameSite, path = '/' }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    'HttpOnly',
    `SameSite=${sameSite}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', [cookie]);
  else res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
}

/* ---------------------------------------------------------------- *
 * Service
 * ---------------------------------------------------------------- */

export class AuthService {
  #config;
  #store;
  #logger;
  #hashes = { gate: null, admin: null };

  constructor({ config, store, logger }) {
    this.#config = config;
    this.#store = store;
    this.#logger = logger;
  }

  /** Derives the password hashes. Must be awaited before serving traffic. */
  async init() {
    const params = this.#config.auth.scrypt;
    this.#hashes.gate = await hashPassword(this.#config.auth.siteGatePassword, params);
    this.#hashes.admin = await hashPassword(this.#config.auth.adminPassword, params);
    this.#logger.info('auth initialised', {
      siteGateEnabled: this.#config.auth.siteGateEnabled,
      scryptN: params.N,
    });
  }

  #cookieName(kind) {
    return kind === 'admin' ? ADMIN_COOKIE : GATE_COOKIE;
  }

  #ttl(kind) {
    return kind === 'admin' ? this.#config.auth.adminSessionTtlMs : this.#config.auth.gateSessionTtlMs;
  }

  /**
   * Admin cookies are SameSite=Strict; the gate cookie is Lax.
   *
   * Lax is required for the gate, otherwise following a link to the site from
   * anywhere else arrives without the cookie and re-prompts on every visit.
   * The admin panel is only ever reached by typing its address or from within
   * the site, so it takes the stricter setting.
   */
  #sameSite(kind) {
    return kind === 'admin' ? 'Strict' : 'Lax';
  }

  async verifyPasswordFor(kind, candidate) {
    const encoded = kind === 'admin' ? this.#hashes.admin : this.#hashes.gate;
    if (!encoded) throw new Error('AuthService.init() was not awaited');
    return verifyPassword(candidate, encoded, this.#config.auth.scrypt);
  }

  /**
   * Exponential backoff driven by consecutive failures since the last
   * success, read from the database so it survives a restart.
   */
  async lockoutStatus(kind, ipHash) {
    const { windowMs, lockoutBaseMs, lockoutMaxMs } = this.#config.rateLimit.login;
    const { failures, lastFailureAt } = await this.#store.consecutiveFailures({ kind, ipHash, windowMs });
    if (failures < 3) return { locked: false, failures, retryAfterMs: 0 };

    // 3 failures -> base, 4 -> 2x base, 5 -> 4x base, capped.
    const penaltyMs = Math.min(lockoutBaseMs * 2 ** (failures - 3), lockoutMaxMs);
    const elapsed = Date.now() - new Date(lastFailureAt).getTime();
    const retryAfterMs = penaltyMs - elapsed;
    if (retryAfterMs <= 0) return { locked: false, failures, retryAfterMs: 0 };
    return { locked: true, failures, retryAfterMs };
  }

  async createSession(kind, req, res) {
    const id = shortId();
    const token = randomToken(32);
    const csrf = newCsrfToken();
    const ttl = this.#ttl(kind);
    const expiresAt = new Date(Date.now() + ttl).toISOString();

    await this.#store.createSession({
      id,
      kind,
      tokenHash: tokenDigest(token),
      csrfToken: csrf,
      expiresAt,
      ipHash: req.ipHash,
      uaHash: req.uaHash,
    });

    appendCookie(
      res,
      serialiseCookie(this.#cookieName(kind), `${id}.${token}`, {
        maxAgeMs: ttl,
        secure: this.#config.isProduction || req.secure,
        sameSite: this.#sameSite(kind),
      }),
    );

    return { id, csrfToken: csrf, expiresAt };
  }

  /**
   * Resolves and validates the session cookie for `kind`.
   * @returns the session row, or null with a reason recorded on the request.
   */
  async resolveSession(kind, req) {
    const raw = req.cookies?.[this.#cookieName(kind)];
    if (!raw) return null;

    const dot = raw.indexOf('.');
    if (dot < 1) return null;
    const id = raw.slice(0, dot);
    const token = raw.slice(dot + 1);
    if (!id || !token) return null;

    const session = await this.#store.getSession(id);
    if (!session || session.kind !== kind) return null;
    if (session.revoked_at) return null;
    if (new Date(session.expires_at).getTime() <= Date.now()) return null;

    // Constant-time comparison of equal-length hex digests.
    const presented = Buffer.from(tokenDigest(token), 'hex');
    const stored = Buffer.from(session.token_hash, 'hex');
    if (presented.length !== stored.length || !crypto.timingSafeEqual(presented, stored)) {
      this.#logger.warn('session token mismatch', { kind, sessionId: id, ipHash: req.ipHash });
      return null;
    }

    const lastSeen = new Date(session.last_seen_at).getTime();

    // An unattended admin panel should not stay open indefinitely.
    if (kind === 'admin') {
      const idleMs = Date.now() - lastSeen;
      if (idleMs > this.#config.auth.adminIdleTimeoutMs) {
        await this.#store.revokeSession(id);
        this.#logger.info('admin session expired through inactivity', { sessionId: id, idleMs });
        return null;
      }
      // Binding to the user agent makes a stolen cookie useless from a
      // different client. The IP is deliberately not bound: mobile networks
      // change it mid-session and would log legitimate admins out constantly.
      if (session.ua_hash && session.ua_hash !== req.uaHash) {
        await this.#store.revokeSession(id);
        this.#logger.warn('admin session rejected: user agent changed', { sessionId: id, ipHash: req.ipHash });
        return null;
      }
    }

    if (Date.now() - lastSeen > TOUCH_INTERVAL_MS) {
      await this.#store.touchSession(id);
    }

    return session;
  }

  async revokeSession(kind, req, res) {
    const raw = req.cookies?.[this.#cookieName(kind)];
    if (raw) {
      const id = raw.slice(0, raw.indexOf('.'));
      if (id) await this.#store.revokeSession(id);
    }
    // Max-Age=0 with attributes matching the original, or browsers keep it.
    appendCookie(
      res,
      serialiseCookie(this.#cookieName(kind), '', {
        maxAgeMs: 0,
        secure: this.#config.isProduction || req.secure,
        sameSite: this.#sameSite(kind),
      }),
    );
  }
}

/* ---------------------------------------------------------------- *
 * Middleware
 * ---------------------------------------------------------------- */

/**
 * Attaches the gate session when present, without requiring it.
 *
 * Runs ahead of the gate itself so that the login page can tell an
 * already-authenticated visitor apart from a new one.
 */
export function attachSessions(auth, config) {
  return async function attachSessionsMiddleware(req, res, next) {
    try {
      if (config.auth.siteGateEnabled) {
        req.gateSession = await auth.resolveSession('gate', req);
      } else {
        req.gateSession = { id: 'gate-disabled' };
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Requires a valid site-gate session. */
export function requireGate(config) {
  return function requireGateMiddleware(req, res, next) {
    if (!config.auth.siteGateEnabled || req.gateSession) return next();

    if (wantsJson(req)) {
      res.status(401).json({
        ok: false,
        error: 'gate_required',
        message: 'This site is private. Enter the access password to continue.',
      });
      return;
    }
    // Preserve where they were going so the gate can return them there.
    const target = encodeURIComponent(req.originalUrl || '/');
    res.redirect(302, `/gate?next=${target}`);
  };
}

/** Requires a valid admin session (and, by ordering, a gate session). */
export function requireAdmin(auth) {
  return async function requireAdminMiddleware(req, res, next) {
    try {
      const session = await auth.resolveSession('admin', req);
      if (!session) {
        if (wantsJson(req)) {
          res.status(401).json({
            ok: false,
            error: 'admin_auth_required',
            message: 'Sign in to the admin panel to continue.',
          });
          return;
        }
        res.redirect(302, '/admin/login');
        return;
      }
      req.adminSession = session;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * CSRF for state-changing admin requests.
 *
 * Double-submit against a token bound to the session row rather than to a
 * second cookie: a token an attacker cannot read and cannot set. SameSite
 * cookies and the origin check are the other two layers.
 */
export function requireCsrf() {
  return function requireCsrfMiddleware(req, res, next) {
    if (!STATE_CHANGING.has(req.method)) return next();

    const presented = req.get('x-csrf-token') ?? '';
    const expected = req.adminSession?.csrf_token ?? '';

    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      req.log?.warn('csrf token rejected', { path: req.path, method: req.method });
      req.recordEvent?.({
        type: 'admin.csrf_rejected',
        severity: 'warn',
        actor: 'admin',
        message: 'CSRF token missing or invalid',
        detail: { path: req.path, method: req.method },
      });
      res.status(403).json({ ok: false, error: 'csrf_invalid', message: 'Security token is invalid. Reload and try again.' });
      return;
    }

    next();
  };
}

/**
 * True when the caller expects JSON rather than a page.
 *
 * Uses originalUrl, not path: inside a mounted router `req.path` is relative
 * to the mount point, so an unauthenticated call to /api/v1/admin/overview
 * sees only "/overview" and would be answered with a redirect to a login page
 * instead of a 401 the client can act on.
 */
function wantsJson(req) {
  const fullPath = req.originalUrl ?? req.path ?? '';
  if (fullPath.startsWith('/api/')) return true;
  if (req.xhr) return true;
  const accept = req.get('accept') ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

export default { AuthService, attachSessions, requireGate, requireAdmin, requireCsrf, cookieParser, parseCookies };

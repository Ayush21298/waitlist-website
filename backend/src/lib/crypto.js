/**
 * Cryptographic helpers.
 *
 * Design notes:
 *  - Passwords are verified against a scrypt hash derived once at boot. The
 *    plaintext never leaves the environment and is never logged or stored.
 *  - Session tokens are random 256-bit values. Only their SHA-256 digest is
 *    persisted, so a database leak does not yield usable sessions, and
 *    individual sessions remain revocable.
 *  - Every comparison of secret material is constant time.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/** Timing-safe equality for strings of any length. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  // timingSafeEqual requires equal lengths, so compare fixed-size digests
  // instead; the digest reveals nothing and keeps the comparison constant time.
  const digestA = crypto.createHash('sha256').update(bufA).digest();
  const digestB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Derives a `scrypt$N$r$p$salt$hash` string. Used for the gate and admin
 * passwords so that the running process holds a hash, not the plaintext.
 */
export async function hashPassword(password, params) {
  const { N, r, p, keyLength, maxmem } = params;
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, keyLength, { N, r, p, maxmem });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Verifies a plaintext candidate against a `hashPassword` string. */
export async function verifyPassword(candidate, encoded, params) {
  if (typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let derived;
  try {
    derived = await scrypt(String(candidate ?? ''), salt, expected.length, {
      N,
      r,
      p,
      maxmem: params?.maxmem ?? 96 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
}

/** 256 bits of entropy, URL-safe. */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Stable, non-reversible identifier for a session token. */
export function tokenDigest(token) {
  return crypto.createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

/** Short opaque identifier, safe to expose in logs and URLs. */
export function shortId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Keyed pseudonym for an IP address or user agent.
 *
 * Lets the system rate-limit, detect abuse and correlate activity without
 * retaining raw personal data in the activity log.
 */
export function keyedHash(value, secret, length = 16) {
  return crypto
    .createHmac('sha256', secret)
    .update(String(value ?? ''), 'utf8')
    .digest('hex')
    .slice(0, length);
}

/** Fresh CSRF token, bound to a session row rather than to a cookie alone. */
export function csrfToken() {
  return randomToken(24);
}

export default {
  safeEqual,
  hashPassword,
  verifyPassword,
  randomToken,
  tokenDigest,
  shortId,
  keyedHash,
  csrfToken,
};

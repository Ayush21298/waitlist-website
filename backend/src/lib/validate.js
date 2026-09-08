/**
 * Input validation and normalisation.
 *
 * Every value that reaches the database passes through here first. The rules
 * are deliberately strict and total: each helper returns either a normalised
 * value or throws a machine-readable error, never a partially-cleaned string.
 */

/**
 * C0/C1 control characters (keeping tab and newline), zero-width characters,
 * bidirectional overrides and the byte-order mark.
 *
 * Invisible characters are stripped rather than rejected: they are a common
 * source of look-alike duplicate signups, and of text that renders one way in
 * the admin panel and another way in a mail client.
 *
 * Built from an escape string so the source file stays pure ASCII.
 */
const CONTROL_AND_INVISIBLE = new RegExp(
  '[' +
    '\\u0000-\\u0008' + // C0 controls, excluding tab (09) and newline (0A)
    '\\u000B-\\u001F' +
    '\\u007F-\\u009F' + // DEL and C1 controls
    '\\u200B-\\u200F' + // zero-width space/joiners, LTR/RTL marks
    '\\u2028-\\u202E' + // line/paragraph separators, bidi overrides
    '\\u2060-\\u2064' + // word joiner and invisible operators
    '\\uFEFF' + // byte-order mark
    ']',
  'gu',
);

export class ValidationError extends Error {
  constructor(field, code, message) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.code = code;
    this.status = 400;
  }
}

/**
 * Removes invisible and control characters, collapses runs of whitespace and
 * trims. Applied before any length check, so padding cannot be used to smuggle
 * an oversized value past a limit.
 */
export function cleanString(input) {
  if (typeof input !== 'string') return '';
  return input.normalize('NFC').replace(CONTROL_AND_INVISIBLE, '').replace(/\s+/gu, ' ').trim();
}

/** Like `cleanString`, but preserves paragraph breaks for free-text notes. */
export function cleanMultiline(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(CONTROL_AND_INVISIBLE, '')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function validateName(raw, { maxLength = 80 } = {}) {
  const value = cleanString(raw);
  if (!value) throw new ValidationError('name', 'name_required', 'Name is required.');
  if (value.length > maxLength) {
    throw new ValidationError('name', 'name_too_long', `Name must be at most ${maxLength} characters.`);
  }
  // A value made only of punctuation is junk or an injection attempt; require
  // at least one letter or ideograph.
  if (!/\p{L}/u.test(value)) {
    throw new ValidationError('name', 'name_invalid', 'Name must contain at least one letter.');
  }
  return value;
}

// Practical addr-spec: no whitespace, a single @, a dotted domain with a
// 2-63 character alphabetic TLD. Intentionally narrower than RFC 5322, which
// permits addresses no real mail provider accepts.
const EMAIL_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function validateEmail(raw, { maxLength = 254 } = {}) {
  const value = cleanString(raw).replace(/\s/gu, '');
  if (!value) throw new ValidationError('email', 'email_required', 'Email is required.');
  if (value.length > maxLength) {
    throw new ValidationError('email', 'email_too_long', `Email must be at most ${maxLength} characters.`);
  }
  if (!EMAIL_RE.test(value)) {
    throw new ValidationError('email', 'email_invalid', 'Email address is not valid.');
  }
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64) {
    throw new ValidationError('email', 'email_invalid', 'Email address is not valid.');
  }
  // Case-insensitive domain, case-preserving local part: the display value
  // keeps what the user typed, the uniqueness key is fully lower-cased.
  return {
    value: `${local}@${domain.toLowerCase()}`,
    normalized: `${local.toLowerCase()}@${domain.toLowerCase()}`,
  };
}

export function validatePhone(raw, { required = false, maxLength = 32 } = {}) {
  const value = cleanString(raw);
  if (!value) {
    if (required) throw new ValidationError('phone', 'phone_required', 'Phone number is required.');
    return { value: '', normalized: '' };
  }
  if (value.length > maxLength) {
    throw new ValidationError('phone', 'phone_too_long', `Phone number must be at most ${maxLength} characters.`);
  }
  if (!/^[+()\-.\s\d]+$/u.test(value)) {
    throw new ValidationError('phone', 'phone_invalid', 'Phone number may only contain digits and + ( ) - .');
  }
  const digits = value.replace(/\D/gu, '');
  // E.164 permits at most 15 digits; 7 is the shortest plausible national number.
  if (digits.length < 7 || digits.length > 15) {
    throw new ValidationError('phone', 'phone_invalid', 'Phone number must contain between 7 and 15 digits.');
  }
  const normalized = value.startsWith('+') ? `+${digits}` : digits;
  return { value, normalized };
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export function validateSlug(raw, field = 'slug') {
  const value = cleanString(raw).toLowerCase();
  if (!value) throw new ValidationError(field, 'slug_required', 'App identifier is required.');
  if (!SLUG_RE.test(value)) {
    throw new ValidationError(field, 'slug_invalid', 'App identifier must be lower-case letters, digits and hyphens.');
  }
  return value;
}

export function validateNote(raw, { maxLength = 2000 } = {}) {
  const value = cleanMultiline(raw);
  if (value.length > maxLength) {
    throw new ValidationError('note', 'note_too_long', `Note must be at most ${maxLength} characters.`);
  }
  return value;
}

const STATUSES = new Set(['pending', 'invited', 'joined', 'removed']);
export const ENTRY_STATUSES = [...STATUSES];

export function validateStatus(raw) {
  const value = cleanString(raw).toLowerCase();
  if (!STATUSES.has(value)) {
    throw new ValidationError('status', 'status_invalid', `Status must be one of: ${ENTRY_STATUSES.join(', ')}.`);
  }
  return value;
}

/** Bounded integer parser for query parameters; never throws. */
export function intParam(raw, { min, max, fallback }) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normalises and caps free text used for searching. */
export function searchTerm(raw, maxLength = 100) {
  return cleanString(raw).slice(0, maxLength);
}

/**
 * Metadata captured alongside a signup (referrer, user agent, campaign).
 * Attacker-controlled, so it is truncated hard and never interpreted.
 */
export function clampMeta(raw, maxLength) {
  return cleanString(raw).slice(0, maxLength);
}

export default {
  ValidationError,
  ENTRY_STATUSES,
  cleanString,
  cleanMultiline,
  validateName,
  validateEmail,
  validatePhone,
  validateSlug,
  validateNote,
  validateStatus,
  intParam,
  searchTerm,
  clampMeta,
};

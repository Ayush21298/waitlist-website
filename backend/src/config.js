/**
 * Central configuration.
 *
 * Every tunable lives here and is read from the environment exactly once, at
 * boot. Anything security-relevant is validated eagerly so that a
 * misconfigured deployment fails to start rather than starting up insecure.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

/** Collected at load time and reported by the logger once it exists. */
export const configWarnings = [];

function str(name, fallback = undefined) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`${name} must be a boolean, got "${raw}"`);
}

function list(name, fallback = []) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Loads `.env` into `process.env` without adding a dependency.
 *
 * Deliberately conservative: `KEY=value` per line, `#` comments, optional
 * surrounding quotes. Existing environment variables always win, so a real
 * platform-provided secret is never shadowed by a stray file.
 */
export function loadDotEnv(file = path.join(ROOT, '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

const MIN_SECRET_BYTES = 32;
const MIN_PASSWORD_LENGTH = 8;

function requireSecret(name, { isProduction, minLength = MIN_SECRET_BYTES }) {
  const value = str(name);
  if (value) {
    if (value.length < minLength) {
      throw new ConfigError(
        `${name} is too short (${value.length} chars, need >= ${minLength}). ` +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
      );
    }
    return value;
  }
  if (isProduction) {
    throw new ConfigError(
      `${name} is required in production. Set it in the environment before starting the server.`,
    );
  }
  const generated = crypto.randomBytes(48).toString('base64url');
  configWarnings.push(
    `${name} was not set; generated an ephemeral value for this process. ` +
      'Sessions will be invalidated on restart. Set it in .env for a stable dev environment.',
  );
  return generated;
}

function requirePassword(name, { isProduction }) {
  const value = str(name);
  if (!value) {
    throw new ConfigError(
      `${name} is required. Set it in .env (development) or in your host's secret store (production).`,
    );
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new ConfigError(`${name} must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (isProduction && /^(changeme|password|secret|admin|test)/i.test(value)) {
    throw new ConfigError(`${name} looks like a placeholder; choose a real password.`);
  }
  return value;
}

export function buildConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  const dataDir = path.resolve(ROOT, str('DATA_DIR', path.join(ROOT, 'data')));
  const logDir = path.resolve(ROOT, str('LOG_DIR', path.join(ROOT, 'logs')));

  const config = {
    nodeEnv,
    isProduction,
    isTest,

    server: {
      host: str('HOST', '0.0.0.0'),
      port: int('PORT', 8080),
      // Number of reverse proxies in front of us. Never `true`: a blanket
      // trust lets a client forge X-Forwarded-For and defeat rate limiting.
      trustProxyHops: int('TRUST_PROXY_HOPS', isProduction ? 1 : 0),
      // Requests are small JSON documents; anything larger is rejected early.
      bodyLimitBytes: int('BODY_LIMIT_BYTES', 16 * 1024),
      requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 20_000),
      keepAliveTimeoutMs: int('KEEP_ALIVE_TIMEOUT_MS', 72_000),
      headersTimeoutMs: int('HEADERS_TIMEOUT_MS', 76_000),
      shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 15_000),
    },

    paths: {
      root: ROOT,
      dataDir,
      logDir,
      frontendDir: path.resolve(ROOT, str('FRONTEND_DIR', path.join(ROOT, 'frontend'))),
    },

    db: {
      // Postgres when DATABASE_URL is present (managed free tiers), otherwise
      // SQLite on local disk. Both adapters expose the same interface.
      url: str('DATABASE_URL'),
      sqlitePath: path.resolve(dataDir, str('SQLITE_FILE', 'waitlist.sqlite')),
      poolMax: int('DB_POOL_MAX', 10),
      connectionTimeoutMs: int('DB_CONNECTION_TIMEOUT_MS', 10_000),
      statementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 10_000),
    },

    auth: {
      siteGateEnabled: bool('SITE_GATE_ENABLED', true),
      siteGatePassword: requirePassword('SITE_GATE_PASSWORD', { isProduction }),
      adminPassword: requirePassword('ADMIN_PASSWORD', { isProduction }),
      sessionSecret: requireSecret('SESSION_SECRET', { isProduction }),
      // Separate salt so that a leaked log file cannot be correlated with
      // session material, and IPs cannot be reversed by brute force alone.
      ipHashSecret: requireSecret('IP_HASH_SECRET', { isProduction }),
      gateSessionTtlMs: int('GATE_SESSION_TTL_MS', 12 * 60 * 60 * 1000),
      adminSessionTtlMs: int('ADMIN_SESSION_TTL_MS', 8 * 60 * 60 * 1000),
      adminIdleTimeoutMs: int('ADMIN_IDLE_TIMEOUT_MS', 45 * 60 * 1000),
      // scrypt parameters for password verification (OWASP-aligned).
      scrypt: {
        N: int('SCRYPT_N', 2 ** 15),
        r: int('SCRYPT_R', 8),
        p: int('SCRYPT_P', 1),
        keyLength: int('SCRYPT_KEYLEN', 32),
        maxmem: int('SCRYPT_MAXMEM', 96 * 1024 * 1024),
      },
    },

    rateLimit: {
      // Sliding-window budgets, per client IP.
      signup: {
        windowMs: int('RL_SIGNUP_WINDOW_MS', 60 * 60 * 1000),
        max: int('RL_SIGNUP_MAX', 10),
      },
      login: {
        windowMs: int('RL_LOGIN_WINDOW_MS', 15 * 60 * 1000),
        max: int('RL_LOGIN_MAX', 8),
        // Failed logins additionally trigger an exponential lockout.
        lockoutBaseMs: int('RL_LOGIN_LOCKOUT_BASE_MS', 2_000),
        lockoutMaxMs: int('RL_LOGIN_LOCKOUT_MAX_MS', 10 * 60 * 1000),
      },
      api: {
        windowMs: int('RL_API_WINDOW_MS', 60 * 1000),
        max: int('RL_API_MAX', 240),
      },
      admin: {
        windowMs: int('RL_ADMIN_WINDOW_MS', 60 * 1000),
        max: int('RL_ADMIN_MAX', 600),
      },
      export: {
        windowMs: int('RL_EXPORT_WINDOW_MS', 60 * 1000),
        max: int('RL_EXPORT_MAX', 20),
      },
    },

    cors: {
      // Empty means same-origin only, which is the intended deployment.
      allowedOrigins: list('CORS_ALLOWED_ORIGINS', []),
    },

    logging: {
      level: str('LOG_LEVEL', isTest ? 'error' : 'info'),
      toFile: bool('LOG_TO_FILE', !isTest),
      toConsole: bool('LOG_TO_CONSOLE', true),
      maxFileBytes: int('LOG_MAX_FILE_BYTES', 8 * 1024 * 1024),
      maxFiles: int('LOG_MAX_FILES', 10),
      // Retention for the queryable activity trail held in the database.
      eventRetentionDays: int('EVENT_RETENTION_DAYS', 365),
    },

    apps: {
      // Where `/` sends visitors. Must match a slug in the apps table.
      defaultSlug: str('DEFAULT_APP_SLUG', 'pages'),
    },

    limits: {
      maxNameLength: int('MAX_NAME_LENGTH', 80),
      maxEmailLength: int('MAX_EMAIL_LENGTH', 254),
      maxPhoneLength: int('MAX_PHONE_LENGTH', 32),
      maxNoteLength: int('MAX_NOTE_LENGTH', 2000),
      maxExportRows: int('MAX_EXPORT_ROWS', 100_000),
      maxPageSize: int('MAX_PAGE_SIZE', 200),
    },
  };

  if (config.auth.siteGatePassword === config.auth.adminPassword) {
    throw new ConfigError(
      'SITE_GATE_PASSWORD and ADMIN_PASSWORD must differ; the site gate is a weaker perimeter than the admin panel.',
    );
  }

  return config;
}

loadDotEnv();

/** The singleton used by the running server. */
export const config = buildConfig();
export default config;

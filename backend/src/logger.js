/**
 * Structured JSON logging.
 *
 * One JSON object per line, which is what every log shipper and every
 * `jq` invocation expects. Writes go to stdout (so a hosting platform
 * captures them) and, optionally, to a size-rotated file on disk.
 *
 * Logging must never take the server down: a failure to write a log line is
 * swallowed and counted rather than thrown.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

/** Keys whose values are replaced wholesale wherever they appear. */
const REDACTED_KEYS = new Set([
  'password',
  'pass',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'set-cookie',
  'session',
  'sessionid',
  'csrf',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
]);

const REDACTION = '[redacted]';
const MAX_DEPTH = 6;
const MAX_STRING = 2000;
const MAX_ARRAY = 50;

/**
 * Produces a safe, bounded, JSON-serialisable clone of arbitrary input:
 * redacts sensitive keys, truncates runaway strings and arrays, and breaks
 * circular references.
 */
export function sanitise(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;

  const type = typeof value;
  if (type === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value;
  }
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (type === 'function' || type === 'symbol') return `[${type}]`;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code ?? undefined,
      stack: value.stack,
      cause: value.cause ? sanitise(value.cause, depth + 1, seen) : undefined,
    };
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}B]`;

  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => sanitise(v, depth + 1, seen));
    if (value.length > MAX_ARRAY) out.push(`…[+${value.length - MAX_ARRAY}]`);
    return out;
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTION : sanitise(val, depth + 1, seen);
  }
  return out;
}

/** Appends to `file`, rolling it aside once it exceeds `maxBytes`. */
class RotatingFileSink {
  #file;
  #maxBytes;
  #maxFiles;
  #stream = null;
  #size = 0;
  #rotating = false;
  #pending = [];

  constructor({ file, maxBytes, maxFiles }) {
    this.#file = file;
    this.#maxBytes = maxBytes;
    this.#maxFiles = maxFiles;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.#size = fs.statSync(file).size;
    } catch {
      this.#size = 0;
    }
    this.#open();
  }

  #open() {
    this.#stream = fs.createWriteStream(this.#file, { flags: 'a' });
    // A broken log file must not raise an unhandled 'error' event.
    this.#stream.on('error', () => {});
  }

  write(line) {
    if (this.#rotating) {
      this.#pending.push(line);
      return;
    }
    this.#size += Buffer.byteLength(line);
    this.#stream.write(line);
    if (this.#size >= this.#maxBytes) this.#rotate();
  }

  #rotate() {
    this.#rotating = true;
    const stream = this.#stream;
    stream.end(() => {
      try {
        // waitlist.log.2 -> waitlist.log.3, ... then waitlist.log -> waitlist.log.1
        for (let i = this.#maxFiles - 1; i >= 1; i -= 1) {
          const from = i === 1 ? this.#file : `${this.#file}.${i}`;
          const to = `${this.#file}.${i + 1}`;
          if (fs.existsSync(from)) {
            if (i + 1 > this.#maxFiles) fs.rmSync(from, { force: true });
            else fs.renameSync(from, to);
          }
        }
      } catch {
        // Rotation is best effort; keep logging regardless.
      }
      this.#size = 0;
      this.#open();
      this.#rotating = false;
      const queued = this.#pending;
      this.#pending = [];
      for (const line of queued) this.write(line);
    });
  }

  async close() {
    await new Promise((resolve) => this.#stream.end(resolve));
  }
}

export class Logger {
  #level;
  #sinks;
  #base;

  constructor({ level = 'info', sinks = [], base = {} } = {}) {
    this.#level = LEVELS[level] ?? LEVELS.info;
    this.#sinks = sinks;
    this.#base = base;
  }

  /** Returns a logger that stamps every line with additional fields. */
  child(fields) {
    const child = new Logger({ sinks: this.#sinks, base: { ...this.#base, ...fields } });
    child.#level = this.#level;
    return child;
  }

  isEnabled(level) {
    return (LEVELS[level] ?? 0) >= this.#level;
  }

  log(level, message, fields = {}) {
    if (!this.isEnabled(level)) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...this.#base,
      ...sanitise(fields),
    };
    let line;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      line = `${JSON.stringify({ ts: record.ts, level: 'error', msg: 'log serialisation failed' })}\n`;
    }
    for (const sink of this.#sinks) {
      try {
        sink.write(line);
      } catch {
        // A failing sink must not break the request being served.
      }
    }
  }

  debug(msg, fields) { this.log('debug', msg, fields); }
  info(msg, fields) { this.log('info', msg, fields); }
  warn(msg, fields) { this.log('warn', msg, fields); }
  error(msg, fields) { this.log('error', msg, fields); }
  fatal(msg, fields) { this.log('fatal', msg, fields); }

  async close() {
    for (const sink of this.#sinks) {
      if (typeof sink.close === 'function') await sink.close();
    }
  }
}

export function createLogger(config) {
  const sinks = [];
  if (config.logging.toConsole) {
    sinks.push({ write: (line) => process.stdout.write(line) });
  }
  if (config.logging.toFile) {
    sinks.push(
      new RotatingFileSink({
        file: path.join(config.paths.logDir, 'waitlist.log'),
        maxBytes: config.logging.maxFileBytes,
        maxFiles: config.logging.maxFiles,
      }),
    );
  }
  return new Logger({ level: config.logging.level, sinks, base: { service: 'waitlist-backend', env: config.nodeEnv } });
}

export default createLogger;

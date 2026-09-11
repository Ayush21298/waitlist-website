/**
 * Static file serving with cached compression.
 *
 * The Pages landing page is a 1.4 MB single file: the design embeds its
 * photographs and webfonts as data URIs. Compression takes it to about
 * 1.0 MB, which is worth having on a mobile connection and worth having on a
 * free hosting tier with a bandwidth allowance.
 *
 * Each asset is compressed once, on first request, and the result is held in
 * memory. Compressing per request would put ~17 ms of CPU on every page load
 * and would be the first thing to fall over with many devices on the page at
 * once. Brotli quality 5 is the operating point: it matches gzip's ratio on
 * this content at half the cost, while quality 11 buys a further 0.6% for
 * roughly a hundred times the CPU.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const CONTENT_TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.map': 'application/json; charset=utf-8',
  }),
);

/**
 * Formats worth compressing. Anything already compressed internally -- PNG,
 * JPEG, WebP, woff2 -- is left alone, because re-compressing it costs CPU and
 * saves nothing.
 *
 * TTF and OTF are the ones easy to overlook: unlike woff2 they carry no
 * internal compression, and a CJK face is enormous. The C-Dots page ships
 * 10.6 MB of TTF, which brotli takes to 2.3 MB -- the single largest saving
 * available anywhere in this project.
 */
const COMPRESSIBLE = new Set([
  '.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.xml', '.webmanifest', '.map',
  '.ttf', '.otf',
]);

const MIN_COMPRESS_BYTES = 1024;
const DEFAULT_CACHE_BUDGET = 192 * 1024 * 1024;

export class AssetCache {
  #entries = new Map();
  #bytes = 0;
  #budget;

  constructor(budgetBytes = DEFAULT_CACHE_BUDGET) {
    this.#budget = budgetBytes;
  }

  get(key) {
    return this.#entries.get(key);
  }

  set(key, value) {
    const size = value.body.length;
    // A cache that can grow without bound is a memory leak with a nice name.
    // The asset set here is small and fixed, so evicting everything on
    // overflow is simpler and safer than tracking recency.
    if (this.#bytes + size > this.#budget) {
      this.#entries.clear();
      this.#bytes = 0;
    }
    this.#entries.set(key, value);
    this.#bytes += size;
  }

  get size() {
    return this.#entries.size;
  }

  get bytes() {
    return this.#bytes;
  }

  clear() {
    this.#entries.clear();
    this.#bytes = 0;
  }
}

function pickEncoding(acceptEncoding, extension) {
  if (!COMPRESSIBLE.has(extension)) return 'identity';
  const accept = (acceptEncoding ?? '').toLowerCase();
  if (accept.includes('br')) return 'br';
  if (accept.includes('gzip')) return 'gzip';
  return 'identity';
}

function compress(buffer, encoding) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
      },
    });
  }
  if (encoding === 'gzip') return zlib.gzipSync(buffer, { level: 6 });
  return buffer;
}

/**
 * Resolves a URL path to a file inside `root`, or null.
 *
 * The resolved path is checked to be inside the root after normalisation,
 * which is what stops `..%2f..%2f/etc/passwd` and its encoded variants from
 * escaping the directory.
 */
export function resolveWithin(root, urlPath, { index = null } = {}) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  // A NUL byte can truncate a path in some downstream consumers.
  if (decoded.includes('\0')) return null;

  const resolved = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }

  if (stat.isDirectory()) {
    if (!index) return null;
    const indexPath = path.join(resolved, index);
    try {
      const indexStat = fs.statSync(indexPath);
      if (!indexStat.isFile()) return null;
      return { file: indexPath, stat: indexStat };
    } catch {
      return null;
    }
  }

  return stat.isFile() ? { file: resolved, stat } : null;
}

/**
 * Sends one file, compressed and cached, honouring conditional requests.
 * Exported so the routes that serve a single page can share the same path.
 */
export async function sendAsset(req, res, file, stat, { cache, maxAgeSeconds = 0, logger }) {
  const extension = path.extname(file).toLowerCase();
  const contentType = CONTENT_TYPES.get(extension) ?? 'application/octet-stream';
  // mtime and size identify a build well enough, and cost no hashing.
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

  res.setHeader('Content-Type', contentType);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}, must-revalidate`);
  // Without Vary, a shared cache can hand a brotli body to a client that
  // cannot decode it.
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());

  if (req.get('if-none-match') === etag) {
    res.status(304).end();
    return;
  }

  const wanted = stat.size >= MIN_COMPRESS_BYTES ? pickEncoding(req.get('accept-encoding'), extension) : 'identity';
  const key = `${file}|${etag}|${wanted}`;

  let entry = cache.get(key);
  if (!entry) {
    const raw = await fsp.readFile(file);
    const body = wanted === 'identity' ? raw : compress(raw, wanted);
    entry = { body, encoding: wanted };
    cache.set(key, entry);
    if (wanted !== 'identity') {
      logger?.debug('asset compressed', {
        file: path.basename(file),
        encoding: wanted,
        from: raw.length,
        to: body.length,
      });
    }
  }

  if (entry.encoding !== 'identity') res.setHeader('Content-Encoding', entry.encoding);
  res.setHeader('Content-Length', String(entry.body.length));

  if (req.method === 'HEAD') {
    res.status(200).end();
    return;
  }
  res.status(200).end(entry.body);
}

/**
 * Express middleware serving `root`, falling through when there is no match.
 *
 * @param {object} options
 * @param {string} options.root      directory to serve
 * @param {string} [options.index]   filename to serve for a directory request
 * @param {number} [options.maxAgeSeconds]
 */
export function compressedStatic({ root, index = null, maxAgeSeconds = 0, cache, logger }) {
  const resolvedRoot = path.resolve(root);
  const assets = cache ?? new AssetCache();

  return function compressedStaticMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const target = resolveWithin(resolvedRoot, req.path, { index });
    if (!target) return next();

    // Dotfiles are never web content, and serving one is usually a mistake
    // that leaks configuration.
    if (path.basename(target.file).startsWith('.')) return next();

    sendAsset(req, res, target.file, target.stat, { cache: assets, maxAgeSeconds, logger }).catch(next);
  };
}

export default compressedStatic;

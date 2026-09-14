/**
 * Generates the PWA icons, with no image library.
 *
 * A PNG is a signature plus a few length-prefixed, CRC-checked chunks wrapping
 * zlib-deflated scanlines. That is little enough code to write directly, and
 * it keeps a service whose whole job is holding contact details free of an
 * image-processing dependency and its transitive tree -- the same reasoning
 * as the hand-rolled XLSX writer.
 *
 * Every icon is drawn with a wide margin so the one file works for both
 * `any` and `maskable`: Android crops a maskable icon to a circle of about
 * 80% diameter, and anything closer to the edge loses its corners.
 *
 * Usage:  npm run icons
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * PNG encoding
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const forCrc = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(forCrc), 8 + data.length);
  return out;
}

/** @param {{width:number,height:number,pixels:Buffer}} image RGBA, 8 bits per channel */
function encodePng({ width, height, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type 6 = truecolour with alpha
  ihdr.writeUInt8(0, 10); // deflate
  ihdr.writeUInt8(0, 11); // adaptive filtering
  ihdr.writeUInt8(0, 12); // no interlace

  // Each scanline is prefixed with its filter type; 0 means "none", which
  // costs a little size and saves a great deal of complexity.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

function hex(colour) {
  const value = colour.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

class Canvas {
  constructor(size, background) {
    this.size = size;
    this.pixels = Buffer.alloc(size * size * 4);
    const [r, g, b] = hex(background);
    for (let i = 0; i < size * size; i += 1) {
      this.pixels[i * 4] = r;
      this.pixels[i * 4 + 1] = g;
      this.pixels[i * 4 + 2] = b;
      this.pixels[i * 4 + 3] = 255;
    }
  }

  /**
   * Blends one pixel. `alpha` is 0..1, which is how the shape helpers get
   * smooth edges: they antialias by supersampling and pass a fractional
   * coverage rather than drawing hard pixels.
   */
  #blend(x, y, [r, g, b], alpha) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size || alpha <= 0) return;
    const i = (y * this.size + x) * 4;
    const a = Math.min(1, alpha);
    this.pixels[i] = Math.round(this.pixels[i] * (1 - a) + r * a);
    this.pixels[i + 1] = Math.round(this.pixels[i + 1] * (1 - a) + g * a);
    this.pixels[i + 2] = Math.round(this.pixels[i + 2] * (1 - a) + b * a);
  }

  /**
   * Fills wherever `inside(x, y)` is true, sampling a 4x4 grid per pixel so
   * curves come out smooth rather than stepped.
   */
  fill(inside, colour) {
    const rgb = hex(colour);
    const S = 4;
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        let hits = 0;
        for (let sy = 0; sy < S; sy += 1) {
          for (let sx = 0; sx < S; sx += 1) {
            if (inside(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) hits += 1;
          }
        }
        if (hits) this.#blend(x, y, rgb, hits / (S * S));
      }
    }
  }

  circle(cx, cy, r, colour) {
    this.fill((x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r, colour);
  }

  ring(cx, cy, outer, inner, colour) {
    this.fill((x, y) => {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      return d <= outer * outer && d >= inner * inner;
    }, colour);
  }

  /** A ring with a wedge removed, which is how the C-Dots "C" is drawn. */
  arc(cx, cy, outer, inner, fromDeg, toDeg, colour) {
    this.fill((x, y) => {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d > outer * outer || d < inner * inner) return false;
      let angle = (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
      if (angle < 0) angle += 360;
      return fromDeg <= toDeg
        ? angle >= fromDeg && angle <= toDeg
        : angle >= fromDeg || angle <= toDeg;
    }, colour);
  }

  roundedRect(x0, y0, x1, y1, radius, colour) {
    this.fill((x, y) => {
      if (x < x0 || x > x1 || y < y0 || y > y1) return false;
      const dx = x < x0 + radius ? x0 + radius - x : x > x1 - radius ? x - (x1 - radius) : 0;
      const dy = y < y0 + radius ? y0 + radius - y : y > y1 - radius ? y - (y1 - radius) : 0;
      return dx * dx + dy * dy <= radius * radius;
    }, colour);
  }

  toPng() {
    return encodePng({ width: this.size, height: this.size, pixels: this.pixels });
  }
}

/* ------------------------------------------------------------------ *
 * The marks
 * ------------------------------------------------------------------ */

/**
 * Each draw function works in fractions of the icon size, so one description
 * renders at every resolution. Content stays inside the central ~62%, which
 * survives the maskable crop with room to spare.
 */
const ICONS = {
  // Pages: a sheet of paper on the brand's near-black, with the purple
  // highlight the landing page uses on its heading.
  pages: {
    background: '#111827',
    themeColor: '#111827',
    draw(c, s) {
      const sheetW = s * 0.34;
      const sheetH = s * 0.44;
      const x0 = (s - sheetW) / 2;
      const y0 = (s - sheetH) / 2;
      c.roundedRect(x0, y0, x0 + sheetW, y0 + sheetH, s * 0.035, '#FFFFFF');
      // Three lines of "text", the middle one highlighted.
      const lineH = s * 0.032;
      const pad = s * 0.055;
      const lineX = x0 + pad;
      const lineW = sheetW - pad * 2;
      c.roundedRect(lineX, y0 + s * 0.09, lineX + lineW, y0 + s * 0.09 + lineH, lineH / 2, '#D1D5DB');
      c.roundedRect(lineX, y0 + s * 0.17, lineX + lineW * 0.82, y0 + s * 0.17 + lineH, lineH / 2, '#AC64FF');
      c.roundedRect(lineX, y0 + s * 0.25, lineX + lineW * 0.6, y0 + s * 0.25 + lineH, lineH / 2, '#D1D5DB');
    },
  },

  // C-Dots: the logo reduced to its two elements, a C and the lighter dot.
  cdots: {
    background: '#FFFFFF',
    themeColor: '#FFFFFF',
    draw(c, s) {
      const cx = s * 0.44;
      const cy = s * 0.5;
      const outer = s * 0.2;
      const inner = s * 0.128;
      // Open on the right, like the wordmark's C.
      c.arc(cx, cy, outer, inner, 36, 324, '#0C0C0E');
      c.circle(s * 0.68, cy, s * 0.062, '#C4C4CC');
    },
  },

  // The index: the R2P purple mark on the app background.
  home: {
    background: '#111827',
    themeColor: '#F9FAFB',
    draw(c, s) {
      c.circle(s * 0.5, s * 0.5, s * 0.17, '#AC64FF');
      c.circle(s * 0.5, s * 0.5, s * 0.075, '#111827');
    },
  },
};

/* ------------------------------------------------------------------ *
 * Write them
 * ------------------------------------------------------------------ */

const TARGETS = {
  pages: path.join(ROOT, 'frontend', 'apps', 'pages', 'icons'),
  cdots: path.join(ROOT, 'frontend', 'apps', 'cdots', 'icons'),
  home: path.join(ROOT, 'frontend', 'home', 'icons'),
};

// 192 and 512 are the two Chrome requires; 180 is what iOS uses for its
// home-screen icon.
const SIZES = [180, 192, 512];

for (const [name, spec] of Object.entries(ICONS)) {
  const dir = TARGETS[name];
  fs.mkdirSync(dir, { recursive: true });
  for (const size of SIZES) {
    const canvas = new Canvas(size, spec.background);
    spec.draw(canvas, size);
    const file = path.join(dir, `icon-${size}.png`);
    fs.writeFileSync(file, canvas.toPng());
    console.log(`  ${path.relative(ROOT, file)}  ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
  }
}

console.log('\nIcons written.');

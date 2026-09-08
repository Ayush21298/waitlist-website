/**
 * Tabular export formats: CSV, TSV, JSON, NDJSON and XLSX.
 *
 * XLSX is produced by writing the OOXML parts into a hand-rolled ZIP
 * container. That keeps a spreadsheet export dependency-free, which matters
 * for a service whose entire job is to hold other people's contact details:
 * every added dependency is added supply-chain risk.
 */
import zlib from 'node:zlib';

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * A waitlist stores attacker-supplied names. Without this, a signup called
 * `=HYPERLINK("http://evil","click")` becomes a live formula the moment an
 * administrator opens the export. Prefixing with an apostrophe forces Excel,
 * LibreOffice and Sheets to treat the value as literal text.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function neutraliseFormula(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return FORMULA_PREFIX.test(str) ? `'${str}` : str;
}

/** RFC 4180 field quoting, applied on top of formula neutralisation. */
function csvField(value, delimiter) {
  const str = neutraliseFormula(value);
  const mustQuote = str.includes(delimiter) || str.includes('"') || /[\n\r]/.test(str);
  return mustQuote ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * @param {{key: string, label: string}[]} columns
 * @param {object[]} rows
 */
export function toCsv(columns, rows, { delimiter = ',', bom = true } = {}) {
  const lines = [columns.map((c) => csvField(c.label, delimiter)).join(delimiter)];
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(row[c.key], delimiter)).join(delimiter));
  }
  // Excel assumes the system code page unless a UTF-8 BOM is present, which
  // would mangle every Korean name in the list.
  return (bom ? '\uFEFF' : '') + lines.join('\r\n') + '\r\n';
}

export function toTsv(columns, rows) {
  return toCsv(columns, rows, { delimiter: '\t' });
}

export function toJson(columns, rows, meta = {}) {
  return `${JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      ...meta,
      count: rows.length,
      columns: columns.map((c) => ({ key: c.key, label: c.label })),
      rows: rows.map((row) => Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? null]))),
    },
    null,
    2,
  )}\n`;
}

export function toNdjson(columns, rows) {
  return rows
    .map((row) => JSON.stringify(Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? null]))))
    .join('\n')
    .concat(rows.length ? '\n' : '');
}

/* ------------------------------------------------------------------ *
 * Minimal ZIP writer (deflate), sufficient for the XLSX package.
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

/** @param {{name: string, data: Buffer}[]} files */
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const compressed = zlib.deflateRawSync(file.data, { level: 6 });
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 filenames
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x0021, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    chunks.push(local, nameBuf, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory signature
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x0021, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(file.data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ------------------------------------------------------------------ *
 * XLSX
 * ------------------------------------------------------------------ */

/**
 * XML 1.0 forbids most control characters outright, even when escaped, so they
 * are dropped rather than encoded. Built from an escape string to keep this
 * source file pure ASCII.
 */
const XML_FORBIDDEN = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 forbids most control characters outright, even escaped.
    .replace(XML_FORBIDDEN, '');
}

/** 0 -> A, 25 -> Z, 26 -> AA */
function columnName(index) {
  let name = '';
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

function cellXml(ref, value) {
  const neutralised = neutraliseFormula(value);
  if (neutralised === '') return '';
  // Numbers are written as numeric cells only when the round trip is exact,
  // so that a phone number like 01012345678 keeps its leading zero.
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(neutralised)}</t></is></c>`;
}

/**
 * Builds a single-sheet workbook. Inline strings are used instead of a shared
 * string table: slightly larger on disk, but far simpler and immune to the
 * index-drift bugs that shared tables invite.
 */
export function toXlsx(columns, rows, { sheetName = 'Waitlist' } = {}) {
  const safeSheetName = xmlEscape(sheetName).slice(0, 31).replace(/[[\]:*?/\\]/g, '-') || 'Sheet1';

  const sheetRows = [];
  sheetRows.push(
    `<row r="1" s="1">${columns.map((c, i) => cellXml(`${columnName(i)}1`, c.label)).join('')}</row>`,
  );
  rows.forEach((row, rowIndex) => {
    const r = rowIndex + 2;
    const cells = columns.map((c, i) => cellXml(`${columnName(i)}${r}`, row[c.key] ?? '')).join('');
    sheetRows.push(`<row r="${r}">${cells}</row>`);
  });

  const lastCol = columnName(Math.max(columns.length - 1, 0));
  const dimension = `A1:${lastCol}${rows.length + 1}`;

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dimension}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${columns
      .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(c.label.length + 6, 12), 46)}" customWidth="1"/>`)
      .join('')}</cols>` +
    `<sheetData>${sheetRows.join('')}</sheetData>` +
    `<autoFilter ref="${dimension}"/>` +
    `</worksheet>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FF111827"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>` +
    `</styleSheet>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(styles, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') },
  ]);
}

export const FORMATS = {
  csv: { extension: 'csv', contentType: 'text/csv; charset=utf-8', build: (c, r) => toCsv(c, r) },
  tsv: { extension: 'tsv', contentType: 'text/tab-separated-values; charset=utf-8', build: (c, r) => toTsv(c, r) },
  json: { extension: 'json', contentType: 'application/json; charset=utf-8', build: (c, r, m) => toJson(c, r, m) },
  ndjson: { extension: 'ndjson', contentType: 'application/x-ndjson; charset=utf-8', build: (c, r) => toNdjson(c, r) },
  xlsx: {
    extension: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    build: (c, r, m) => toXlsx(c, r, { sheetName: m?.sheetName ?? 'Waitlist' }),
  },
};

/** Builds a download filename that is safe on every filesystem. */
export function exportFilename(prefix, format) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'export';
  return `${safePrefix}_${stamp}.${FORMATS[format].extension}`;
}

export default { toCsv, toTsv, toJson, toNdjson, toXlsx, FORMATS, exportFilename, neutraliseFormula };

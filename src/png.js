/**
 * Original, dependency-free PNG codec for DMI files. Decodes every non-interlaced colour type
 * and bit depth to straight (non-premultiplied) RGBA8; encodes RGBA8. Uses only node:zlib.
 * Interlaced (Adam7) images are rejected with a diagnostic rather than decoded.
 */
import { inflateSync, deflateSync, crc32 } from 'node:zlib';

export class PngError extends Error { constructor(message) { super(message); this.name = 'PngError'; } }
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/** Chunks with CRC verification. Text chunks are returned decoded; zTXt is inflated with a bound. */
export function readChunks(bytes, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length > maxBytes) throw new PngError('PNG byte limit exceeded');
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError('Not a PNG file');
  const chunks = []; let pos = 8;
  while (pos < buf.length) {
    if (pos + 12 > buf.length) throw new PngError('Truncated chunk');
    const length = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8);
    if (length > buf.length - pos - 12) throw new PngError(`Truncated ${type} chunk`);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if ((crc32(buf.subarray(pos + 4, pos + 8 + length)) >>> 0) !== buf.readUInt32BE(pos + 8 + length)) throw new PngError(`Bad CRC in ${type} chunk`);
    chunks.push({ type, data }); pos += 12 + length;
    if (type === 'IEND') break;
  }
  if (chunks[0]?.type !== 'IHDR') throw new PngError('Missing IHDR');
  if (chunks.at(-1)?.type !== 'IEND') throw new PngError('Missing IEND');
  return chunks;
}

/** Text chunks (tEXt, zTXt, uncompressed iTXt) keyed by keyword. */
export function textChunks(chunks, { maxText = 16 * 1024 * 1024 } = {}) {
  const out = new Map();
  for (const { type, data } of chunks) {
    if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') continue;
    const nul = data.indexOf(0); if (nul < 1) continue;
    const key = data.toString('latin1', 0, nul);
    let text;
    if (type === 'tEXt') text = data.toString('latin1', nul + 1);
    else if (type === 'zTXt') text = inflateSync(data.subarray(nul + 2), { maxOutputLength: maxText }).toString('utf8');
    else {
      if (data[nul + 1] !== 0) continue; // compressed iTXt is not used by DMI
      let p = data.indexOf(0, nul + 3); p = data.indexOf(0, p + 1); text = data.toString('utf8', p + 1);
    }
    out.set(key, text);
  }
  return out;
}

function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }

/** Decode to {width, height, rgba: Uint8Array, colorType, bitDepth, text: Map}. */
export function decodePng(bytes, { maxPixels = 64 * 1024 * 1024 } = {}) {
  const chunks = readChunks(bytes), ihdr = chunks[0].data;
  if (ihdr.length !== 13) throw new PngError('Bad IHDR length');
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4), bitDepth = ihdr[8], colorType = ihdr[9];
  if (!width || !height) throw new PngError('Zero image size');
  if (width * height > maxPixels) throw new PngError('Pixel limit exceeded');
  if (!DEPTHS[colorType]?.includes(bitDepth)) throw new PngError(`Unsupported colour type ${colorType} at depth ${bitDepth}`);
  if (ihdr[10] !== 0 || ihdr[11] !== 0) throw new PngError('Unsupported compression or filter method');
  if (ihdr[12] !== 0) throw new PngError('Interlaced (Adam7) PNG is not supported');
  const plte = chunks.find(c => c.type === 'PLTE')?.data, trns = chunks.find(c => c.type === 'tRNS')?.data;
  if (colorType === 3 && !plte) throw new PngError('Palette image without PLTE');
  const channels = CHANNELS[colorType], bpp = Math.max(1, (channels * bitDepth) >> 3);
  const stride = Math.ceil((width * channels * bitDepth) / 8), expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new PngError(`Image data is ${raw.length} bytes, expected ${expected}`);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride), rgba = new Uint8Array(width * height * 4);
  const sample16 = (row, i) => (row[i] << 8) | row[i + 1];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, x = line[i];
      cur[i] = filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : filter === 4 ? x + paeth(a, b, c)
        : (() => { throw new PngError(`Bad filter type ${filter}`); })();
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r, g, bl, al = 255;
      if (bitDepth < 8) {
        const bit = x * bitDepth, v = (cur[bit >> 3] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
        if (colorType === 3) {
          if (v * 3 + 2 >= plte.length) throw new PngError('Palette index out of range');
          r = plte[v * 3]; g = plte[v * 3 + 1]; bl = plte[v * 3 + 2]; al = trns && v < trns.length ? trns[v] : 255;
        } else {
          r = g = bl = Math.round((v * 255) / ((1 << bitDepth) - 1));
          if (trns && trns.length >= 2 && trns.readUInt16BE(0) === v) al = 0;
        }
      } else if (bitDepth === 8) {
        const i = x * channels;
        if (colorType === 3) {
          const v = cur[i]; if (v * 3 + 2 >= plte.length) throw new PngError('Palette index out of range');
          r = plte[v * 3]; g = plte[v * 3 + 1]; bl = plte[v * 3 + 2]; al = trns && v < trns.length ? trns[v] : 255;
        } else if (colorType === 0) { r = g = bl = cur[i]; if (trns && trns.length >= 2 && trns.readUInt16BE(0) === cur[i]) al = 0; }
        else if (colorType === 4) { r = g = bl = cur[i]; al = cur[i + 1]; }
        else if (colorType === 2) { r = cur[i]; g = cur[i + 1]; bl = cur[i + 2]; if (trns && trns.length >= 6 && trns.readUInt16BE(0) === r && trns.readUInt16BE(2) === g && trns.readUInt16BE(4) === bl) al = 0; }
        else { r = cur[i]; g = cur[i + 1]; bl = cur[i + 2]; al = cur[i + 3]; }
      } else {
        const i = x * channels * 2, s = k => sample16(cur, i + 2 * k), to8 = v => v >> 8;
        if (colorType === 0) { r = g = bl = to8(s(0)); if (trns && trns.readUInt16BE(0) === s(0)) al = 0; }
        else if (colorType === 4) { r = g = bl = to8(s(0)); al = to8(s(1)); }
        else if (colorType === 2) { r = to8(s(0)); g = to8(s(1)); bl = to8(s(2)); if (trns && trns.length >= 6 && trns.readUInt16BE(0) === s(0) && trns.readUInt16BE(2) === s(1) && trns.readUInt16BE(4) === s(2)) al = 0; }
        else { r = to8(s(0)); g = to8(s(1)); bl = to8(s(2)); al = to8(s(3)); }
      }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = bl; rgba[o + 3] = al;
    }
    prev.set(cur);
  }
  return { width, height, rgba, colorType, bitDepth, text: textChunks(chunks) };
}

function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode RGBA8 as a PNG (filter 0 rows; optional zTXt chunks as {keyword: text}). */
export function encodePng({ width, height, rgba }, { text = {} } = {}) {
  if (rgba.length !== width * height * 4) throw new PngError('RGBA buffer size mismatch');
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const texts = Object.entries(text).map(([k, v]) => chunk('zTXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0, 0]), deflateSync(Buffer.from(v, 'utf8'))])));
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), ...texts, chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Encode full RGBA8 frames of one size as an animated PNG (APNG). delaysMs: per-frame display
 * time in milliseconds; plays: 0 loops forever. The first frame is also the default image, so
 * viewers without APNG support show it. Every frame replaces the canvas (blend source, no dispose).
 */
export function encodeApng(frames, { width, height, delaysMs, plays = 0, text = {} }) {
  if (!frames.length) throw new PngError('An animation needs at least one frame');
  if (delaysMs.length !== frames.length) throw new PngError('One delay per frame is required');
  const rows = rgba => {
    if (rgba.length !== width * height * 4) throw new PngError('RGBA buffer size mismatch');
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
    return deflateSync(raw);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const actl = Buffer.alloc(8); actl.writeUInt32BE(frames.length, 0); actl.writeUInt32BE(plays, 4);
  let seq = 0;
  const fctl = ms => {
    const b = Buffer.alloc(26); b.writeUInt32BE(seq++, 0); b.writeUInt32BE(width, 4); b.writeUInt32BE(height, 8);
    b.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(ms))), 20); b.writeUInt16BE(1000, 22); // delay = ms / 1000 s
    b[24] = 0; b[25] = 0; return chunk('fcTL', b);
  };
  const texts = Object.entries(text).map(([k, v]) => chunk('zTXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0, 0]), deflateSync(Buffer.from(v, 'utf8'))])));
  const out = [SIGNATURE, chunk('IHDR', ihdr), chunk('acTL', actl), ...texts];
  frames.forEach((rgba, n) => {
    out.push(fctl(delaysMs[n]));
    if (n === 0) out.push(chunk('IDAT', rows(rgba)));
    else { const seqBuf = Buffer.alloc(4); seqBuf.writeUInt32BE(seq++, 0); out.push(chunk('fdAT', Buffer.concat([seqBuf, rows(rgba)]))); }
  });
  out.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(out);
}

/** APNG frame count, plays and per-frame delays (ms) from the control chunks, or null for a still PNG. */
export function apngInfo(bytes) {
  const chunks = readChunks(bytes), actl = chunks.find(c => c.type === 'acTL');
  if (!actl) return null;
  const delays = chunks.filter(c => c.type === 'fcTL').map(c => { const num = c.data.readUInt16BE(20), den = c.data.readUInt16BE(22) || 100; return Math.round(num * 1000 / den); });
  return { frames: actl.data.readUInt32BE(0), plays: actl.data.readUInt32BE(4), delaysMs: delays, fdat: chunks.filter(c => c.type === 'fdAT').length };
}

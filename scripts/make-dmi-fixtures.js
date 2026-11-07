#!/usr/bin/env node
// Generates the original DMI fixtures in fixtures/dmi: every PNG colour type and bit depth,
// all five row filters, transparency chunks, duplicate and movement states.
// Deterministic; re-running produces identical bytes.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
const OUT = 'fixtures/dmi';
const SIZE = 4;
// States: [name, dirs, frames, movement]
export const STATES = [['a', 4, 1, 0], ['b', 1, 2, 0], ['a', 1, 1, 0], ['a', 1, 1, 1], ['', 1, 1, 0]];
const ICONS = STATES.reduce((n, s) => n + s[1] * s[2], 0); // 9
const COLUMNS = 3, W = SIZE * COLUMNS, H = SIZE * Math.ceil(ICONS / COLUMNS);
let seed = 1; const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
function description() {
  let t = `# BEGIN DMI\nversion = 4.0\n\twidth = ${SIZE}\n\theight = ${SIZE}\n`;
  for (const [n, d, f, m] of STATES) { t += `state = "${n}"\n\tdirs = ${d}\n\tframes = ${f}\n`; if (f > 1) t += `\tdelay = ${Array(f).fill(1).join(',')}\n`; if (m) t += '\tmovement = 1\n'; }
  return t + '# END DMI\n';
}
function build(name, colorType, depth, { trns, palette } = {}) {
  seed = colorType * 100 + depth;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType], max = 2 ** depth - 1;
  const bpp = Math.max(1, (channels * depth) >> 3), stride = Math.ceil((W * channels * depth) / 8);
  const rows = [];
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(stride); let bit = 0;
    for (let x = 0; x < W; x++) for (let c = 0; c < channels; c++) {
      const v = colorType === 3 ? Math.floor(rand() * palette) : (x + y) % 5 === 0 && c === channels - 1 && (colorType === 4 || colorType === 6) ? 0 : Math.floor(rand() * (max + 1));
      if (depth === 16) { row.writeUInt16BE(v, bit >> 3); bit += 16; }
      else if (depth === 8) { row[bit >> 3] = v; bit += 8; }
      else { row[bit >> 3] |= v << (8 - depth - (bit & 7)); bit += depth; }
    }
    rows.push(row);
  }
  // Apply filters 0-4 cyclically so the decoder's every reconstruction path is exercised.
  const raw = []; let prev = Buffer.alloc(stride);
  rows.forEach((cur, y) => {
    const f = y % 5, out = Buffer.alloc(stride + 1); out[0] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      out[i + 1] = (cur[i] - [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]) & 255;
    }
    raw.push(out); prev = cur;
  });
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = depth; ihdr[9] = colorType;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('zTXt', Buffer.concat([Buffer.from('Description\0\0', 'latin1'), deflateSync(Buffer.from(description()))]))];
  if (colorType === 3) {
    const plte = Buffer.alloc(palette * 3); for (let i = 0; i < plte.length; i++) plte[i] = Math.floor(rand() * 256);
    parts.push(chunk('PLTE', plte));
    if (trns) { const t = Buffer.alloc(Math.min(palette, 3)); t[0] = 0; if (t.length > 1) t[1] = 128; if (t.length > 2) t[2] = 255; parts.push(chunk('tRNS', t)); }
  } else if (trns) {
    const t = Buffer.alloc(colorType === 0 ? 2 : 6); t.writeUInt16BE(rows[0][0] >> (depth < 8 ? 8 - depth : 0), 0); parts.push(chunk('tRNS', t));
  }
  // Split image data over two IDAT chunks.
  const z = deflateSync(Buffer.concat(raw)), half = z.length >> 1;
  parts.push(chunk('IDAT', z.subarray(0, half)), chunk('IDAT', z.subarray(half)), chunk('IEND', Buffer.alloc(0)));
  writeFileSync(`${OUT}/${name}.dmi`, Buffer.concat(parts));
}
mkdirSync(OUT, { recursive: true });
for (const d of [1, 2, 4, 8, 16]) build(`gray${d}`, 0, d, { trns: d === 8 });
build('rgb8', 2, 8, { trns: true }); build('rgb16', 2, 16);
for (const d of [1, 2, 4, 8]) build(`palette${d}`, 3, d, { palette: 2 ** d, trns: true });
build('grayalpha8', 4, 8); build('grayalpha16', 4, 16); build('rgba8', 6, 8); build('rgba16', 6, 16);
console.log('wrote fixtures/dmi');

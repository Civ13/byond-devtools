#!/usr/bin/env node
// Native DMI pixel agreement: compare decodeDmi with DreamDaemon icon.GetPixel.
//   node scripts/native-icons.js record --byond BIN            re-record fixtures/dmi/pixels.native.json
//   node scripts/native-icons.js corpus --byond BIN --root DIR [--limit N]   sample a checkout's icons
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeDmi, pixelText, DIR_ORDER } from '../src/dmi.js';
import { recordIconPixels } from '../src/native.js';

/** Every pixel of every lookup the fixtures exercise, including missing states, dirs and frames. */
export function fixtureQueries() {
  const q = [];
  for (const [state, moving] of [['a', false], ['b', false], ['', false], ['a', true], ['b', true], ['missing', false]])
    for (const dir of [2, 1, 4, 8, 6]) for (const frame of [1, 2, 3]) for (let y = 1; y <= 4; y++) for (let x = 1; x <= 4; x++) q.push({ state, dir, frame, moving, x, y });
  return q;
}
/** Deterministic sample: up to `states` states, every dir, up to 2 frames, `per` pixels each. */
export function sampleQueries(icon, { states = 6, per = 6 } = {}) {
  const q = []; let k = 0;
  for (const s of icon.states.slice(0, states)) for (const dir of DIR_ORDER.slice(0, s.dirs)) for (let frame = 1; frame <= Math.min(s.frames, 2); frame++)
    for (let i = 0; i < per; i++, k++) q.push({ state: s.name, dir, frame, moving: s.movement, x: 1 + ((k * 7 + i * 13) % icon.width), y: 1 + ((k * 11 + i * 5) % icon.height) });
  return q;
}
/** What the decoder says GetPixel returns. */
export function decodedPixel(icon, { state, dir, frame, moving, x, y }) {
  const s = icon.findState(state, { movement: moving }); const px = s && icon.frame(s, dir, frame);
  return px ? pixelText(px, ((y - 1) * icon.width + (x - 1)) * 4) : null;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2), opt = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const binDir = opt('--byond');
  if (!binDir || !['record', 'corpus'].includes(command)) { console.error('Usage: native-icons.js record|corpus --byond BIN [--root DIR] [--limit N]'); process.exit(2); }
  if (command === 'record') {
    const dir = 'fixtures/dmi', files = {};
    for (const f of readdirSync(dir).filter(f => f.endsWith('.dmi')).sort()) files[path.join(dir, f)] = fixtureQueries();
    const r = await recordIconPixels({ files, binDir });
    const out = { byond: r.byond, queries: 'fixtureQueries()', results: Object.fromEntries(Object.entries(r.results).map(([k, v]) => [path.basename(k), v])) };
    writeFileSync(path.join(dir, 'pixels.native.json'), JSON.stringify(out) + '\n');
    console.log(`recorded ${Object.keys(files).length} fixture icons`);
    return;
  }
  const root = opt('--root'), limit = Number(opt('--limit') || 1e9), all = [];
  (function walk(d) { for (const e of readdirSync(path.join(root, d), { withFileTypes: true })) { const r = path.join(d, e.name); if (e.isDirectory()) walk(r); else if (r.endsWith('.dmi')) all.push(r); } })('.');
  all.sort();
  const files = {}, decoded = {}, failures = [];
  for (const rel of all.slice(0, limit)) {
    const full = path.join(root, rel);
    try { const icon = decodeDmi(readFileSync(full)); const q = sampleQueries(icon); files[full] = q; decoded[full] = q.map(x => decodedPixel(icon, x)); }
    catch (e) { failures.push({ file: rel, error: e.message }); }
  }
  const r = await recordIconPixels({ files, binDir });
  let pixels = 0; const mismatches = [];
  for (const [file, values] of Object.entries(r.results)) values.forEach((v, i) => { pixels++; if ((v ?? null) !== decoded[file][i] && mismatches.length < 50) mismatches.push({ file: path.relative(root, file), query: files[file][i], decoded: decoded[file][i], native: v ?? null }); });
  console.log(JSON.stringify({ byond: r.byond, icons: Object.keys(files).length, pixels, mismatches: mismatches.length, decodeFailures: failures, examples: mismatches.slice(0, 10) }, null, 2));
  if (mismatches.length || failures.length) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

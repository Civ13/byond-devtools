#!/usr/bin/env node
// Native BYOND agreement: compile + boot maps in DreamDaemon and compare with the parser.
//   node scripts/native.js check  --byond BIN [--record DIR] MAP...
//   node scripts/native.js corpus --byond BIN --root CHECKOUT [--max-cells N] [--limit N]
// BIN is a BYOND bin directory (the one holding DreamMaker/DreamDaemon or dm.exe/dd.exe).
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseDmm } from '../src/dmm.js';
import { compareWorld } from '../src/world.js';
import { recordNative } from '../src/native.js';
const [command, ...rest] = process.argv.slice(2);
const opts = {}, files = [];
for (let i = 0; i < rest.length; i++) rest[i].startsWith('--') ? opts[rest[i].slice(2)] = rest[++i] : files.push(rest[i]);
if (!['check', 'corpus'].includes(command) || !opts.byond) {
  console.error('Usage: node scripts/native.js check --byond BIN [--record DIR] MAP... | corpus --byond BIN --root CHECKOUT [--max-cells N] [--limit N]');
  process.exit(2);
}
async function one(file, label) {
  const text = await readFile(file, 'utf8'), map = parseDmm(text);
  const native = await recordNative(map, text, { binDir: opts.byond, resourceRoot: opts['resource-root'] || (command === 'corpus' ? path.resolve(opts.root) : undefined) });
  if (native.status !== 'ok') return { map: label, status: native.status, log: (native.compiler + (native.runtime || '')).split('\n').filter(l => /error|fail|runtime/i.test(l)).slice(0, 5) };
  if (opts.record) { await mkdir(opts.record, { recursive: true }); await writeFile(path.join(opts.record, path.basename(file, '.dmm') + '.native.json'), JSON.stringify(native.dump) + '\n'); }
  return { map: label, status: native.status, byond: native.dump.byond, ...compareWorld(map, native.dump, { maxReported: 10 }) };
}
const results = [];
if (command === 'check') for (const f of files) results.push(await one(f, f.split(path.sep).join('/')));
else {
  const maxCells = Number(opts['max-cells'] || 60000), limit = Number(opts.limit || 1e9), all = [];
  const stack = ['maps'];
  while (stack.length) { const d = stack.pop(); for (const e of await readdir(path.join(opts.root, d), { withFileTypes: true })) { const r = path.join(d, e.name); if (e.isDirectory()) stack.push(r); else if (r.endsWith('.dmm')) all.push(r); } }
  all.sort();
  for (const rel of all) {
    if (results.filter(r => r.status === 'ok').length >= limit) break;
    const text = await readFile(path.join(opts.root, rel), 'utf8'), map = parseDmm(text);
    const s = map.summary(), volume = (s.bounds.maxX) * (s.bounds.maxY) * (s.bounds.maxZ);
    if (volume > maxCells) { results.push({ map: rel.split(path.sep).join('/'), status: 'skipped-size', volume }); continue; }
    results.push(await one(path.join(opts.root, rel), rel.split(path.sep).join('/')));
  }
}
const ok = results.filter(r => r.status === 'ok'), disagree = ok.filter(r => !r.agree);
console.log(JSON.stringify({ schemaVersion: 1, command, compared: ok.length, agreed: ok.length - disagree.length,
  cells: ok.reduce((n, r) => n + r.cells, 0), overrides: ok.reduce((n, r) => n + r.checkedOverrides, 0),
  statuses: results.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {}), results }, null, 2));
// A disagreement is a failure. In check mode a map that cannot be compiled is also a failure;
// in corpus mode it is reported (real maps may use project macros the stub project cannot know).
if (disagree.length || (command === 'check' && ok.length !== results.length) || (command === 'corpus' && !ok.length)) process.exitCode = 1;

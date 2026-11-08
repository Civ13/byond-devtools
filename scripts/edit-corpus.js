#!/usr/bin/env node
// Applies sample edits to every map of a Civ13 checkout (in memory and in a temp folder only)
// and checks the result with Civ13's own tools:
//   - mapmerge2 loads the edited map and writes it back byte for byte (when it does so for the
//     original), so the edit kept mapmerge2's DMM/TGM style and key order;
//   - scripts/maplint.py reports no errors that the original did not have;
//   - the inverse patch restores every cell;
//   - a resize to the same size is byte-identical, and growing then shrinking keeps every tile.
// The checkout is never written. Usage: node scripts/edit-corpus.js --root CIV13 [--python EXE] [--limit N]
import { readFile, writeFile, mkdtemp, rm, readdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os'; import path from 'node:path';
import { parseDmm } from '../src/dmm.js';
import { planEdit } from '../src/edit.js';
import { planResize } from '../src/resize.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const root = arg('root'), python = arg('python', process.platform === 'win32' ? 'py' : 'python3'), limit = Number(arg('limit', 1e9));
if (!root) { console.error('--root is required'); process.exit(2); }
const keep = arg('keep');
const pyArgs = python === 'py' ? ['-3'] : [];

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out); else if (e.name.endsWith('.dmm')) out.push(full);
  }
  return out;
}
const ROUNDTRIP = `import sys
sys.path.insert(0, sys.argv[1])
from mapmerge2 import dmm
for f in open(sys.argv[2], encoding='utf-8').read().splitlines():
    data = open(f, 'rb').read()
    try:
        out = dmm.DMM.from_bytes(data).to_bytes()
        if out != data and f.endswith('.orig.dmm'):
            open(f + '.norm', 'wb').write(out)
        print('RESULT ' + ('same' if out == data else 'differs'))
    except Exception as e:
        print('RESULT error ' + type(e).__name__)
`;
function sampleEdits(map) {
  // Three deterministic cells: reuse another cell's stack, add a new object, and add a var-edited area.
  const cells = [...map.cells()], pick = n => cells[Math.floor((cells.length - 1) * n)];
  const a = pick(0.25), b = pick(0.5), c = pick(0.75);
  const raw = cell => cell.atoms.map(x => x.raw.trim());
  const edits = [];
  if (a.key !== b.key) edits.push({ x: a.x, y: a.y, z: a.z, expect: raw(a), set: raw(b) });
  edits.push({ x: b.x, y: b.y, z: b.z, expect: raw(b), set: ['/obj/item{name = "devtools; edit"; dir = 4}', ...raw(b)] });
  if (c !== a && c !== b && !(c.x === b.x && c.y === b.y && c.z === b.z)) edits.push({ x: c.x, y: c.y, z: c.z, expect: raw(c), set: [...raw(c).filter(x => !x.startsWith('/obj')), '/obj/structure{pixel_x = -4}'].sort((p, q) => rank(p) - rank(q)) });
  return edits;
}
const rank = p => p.startsWith('/turf') ? 1 : p.startsWith('/area') ? 2 : 0;

const files = (await walk(path.join(root, 'maps'))).sort().slice(0, limit);
const dir = await mkdtemp(path.join(os.tmpdir(), 'byond-edit-corpus-'));
const failures = [], stats = { maps: 0, edits: 0, newKeys: 0, mapmergeSame: 0, mapmergeOriginalDiffers: 0, mapmergeNormalizedSame: 0, keySpaceFull: 0, skipped: 0, resized: 0 };
try {
  const pending = [];
  for (const [i, file] of files.entries()) {
    const text = await readFile(file, 'utf8');
    let map; try { map = parseDmm(text); } catch { stats.skipped++; continue; }
    if (map.diagnostics.length) { stats.skipped++; continue; }
    const patch = { edits: sampleEdits(map) };
    let r;
    try { r = planEdit(text, patch); } catch (e) {
      if (/no free .*dictionary key/.test(e.message)) { stats.keySpaceFull++; continue; }
      failures.push(`${file}: ${e.message}`); continue;
    }
    stats.maps++; stats.edits += r.changes.length; stats.newKeys += r.newKeys.length;
    // The inverse patch must restore every cell's stack.
    const undone = planEdit(r.text, r.inverse), before = [...map.cells()], after = [...parseDmm(undone.text).cells()];
    if (before.some((c, j) => c.atoms.map(a => a.raw).join() !== after[j].atoms.map(a => a.raw).join())) failures.push(`${file}: inverse patch did not restore the map`);
    // Resizing to the same size rewrites the grid in the map's own style: it must be byte-identical.
    // Growing by a tile and shrinking back must give the same grid (the fill entry stays, unused).
    try {
      if (planResize(text, {}).text !== text) failures.push(`${file}: resize to the same size changed the file`);
      const w = map.world, fill = map.inspectCell(1, 1, 1)?.atoms.map(a => a.raw.trim()).filter(a => /^\/(turf|area)\b/.test(a));
      if (fill?.length === 2) {
        const grown = planResize(text, { maxX: w.maxX + 1, maxY: w.maxY + 1, fill }), back = planResize(grown.text, { maxX: w.maxX, maxY: w.maxY });
        const cellsOf = t => [...parseDmm(t).cells()].map(c => `${c.x},${c.y},${c.z}=${c.atoms.map(a => a.raw).join()}`).join('\n');
        if (cellsOf(back.text) !== cellsOf(text)) failures.push(`${file}: resize grow and shrink did not restore every tile`);
        else stats.resized++;
      }
    } catch (e) { if (!/no free .*dictionary key/.test(e.message)) failures.push(`${file}: resize: ${e.message}`); }
    const orig = path.join(dir, `${i}.orig.dmm`), edited = path.join(dir, `${i}.edit.dmm`);
    await writeFile(orig, text); await writeFile(edited, r.text);
    pending.push({ file, orig, edited });
  }
  // One Python process for the whole corpus.
  // File lists go through a file: hundreds of temp paths overflow the Windows command line.
  const list = async (name, files) => { const f = path.join(dir, name); await writeFile(f, files.join('\n')); return f; };
  const rt = spawnSync(python, [...pyArgs, '-c', ROUNDTRIP, path.join(root, 'tools'), await list('first.txt', pending.flatMap(p => [p.orig, p.edited]))], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (rt.status !== 0) throw new Error(`mapmerge2 round trip failed: ${rt.stderr}`);
  const lines = rt.stdout.split(/\r?\n/).filter(l => l.startsWith('RESULT ')).map(l => l.slice(7)); // mapmerge2 prints warnings too
  const normalized = [];
  for (const [j, p] of pending.entries()) {
    const [o, e] = [lines[2 * j], lines[2 * j + 1]];
    if (o !== 'same') { stats.mapmergeOriginalDiffers++; if (e.startsWith('error') || o.startsWith('error')) failures.push(`${p.file}: mapmerge2 ${o} / ${e}`); else normalized.push(p); continue; }
    if (e === 'same') stats.mapmergeSame++; else { failures.push(`${p.file}: mapmerge2 rewrites the edited map (${e})`); if (keep) { await copyFile(p.orig, path.join(keep, path.basename(p.orig))); await copyFile(p.edited, path.join(keep, path.basename(p.edited))); } }
  }
  // Maps mapmerge2 itself would rewrite: edit its normalized output instead, which must then be stable.
  const second = [];
  for (const p of normalized) {
    const text = await readFile(p.orig + '.norm', 'utf8').catch(() => null);
    if (text === null) { failures.push(`${p.file}: mapmerge2 reported a difference but wrote no normalized copy`); continue; }
    try { const r = planEdit(text, { edits: sampleEdits(parseDmm(text)) }); await writeFile(p.edited + '.norm', r.text); second.push(p); }
    catch (e) { failures.push(`${p.file} (mapmerge2-normalized): ${e.message}`); }
  }
  if (second.length) {
    const rt2 = spawnSync(python, [...pyArgs, '-c', ROUNDTRIP, path.join(root, 'tools'), await list('second.txt', second.map(p => p.edited + '.norm'))], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const l2 = rt2.stdout.split(/\r?\n/).filter(l => l.startsWith('RESULT ')).map(l => l.slice(7));
    second.forEach((p, j) => { if (l2[j] === 'same') stats.mapmergeNormalizedSame++; else failures.push(`${p.file}: mapmerge2 rewrites the edited normalized map (${l2[j]})`); });
  }
  // maplint: no new errors compared with the original.
  const lint = f => spawnSync(python, [...pyArgs, path.join(root, 'scripts', 'maplint.py'), f], { encoding: 'utf8' });
  // Errors by kind, key names left out: an edit on a tile that already breaks a rule (a map
  // variation's turf-less keep marker) makes new keys that break it the same way.
  const errors = out => new Set(out.split('\n').filter(l => /error/i.test(l) && !/^maplint:/.test(l))
    .map(l => l.replace(/^.*?\.dmm:?/, '').replace(/key "[^"]*"/g, 'key').trim()));
  for (const p of pending) {
    const o = lint(p.orig), e = lint(p.edited), had = errors(o.stdout + o.stderr);
    if (e.status !== 0 && [...errors(e.stdout + e.stderr)].some(k => !had.has(k))) failures.push(`${p.file}: maplint errors after edit:\n${e.stdout}${e.stderr}`);
  }
} finally { await rm(dir, { recursive: true, force: true }); }
console.log(JSON.stringify(stats));
for (const f of failures.slice(0, 30)) console.error(f);
if (failures.length || stats.maps < Math.min(250, files.length - 20)) { console.error(`${failures.length} failures`); process.exit(1); }

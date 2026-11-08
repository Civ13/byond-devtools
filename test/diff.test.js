import test from 'node:test'; import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os'; import path from 'node:path';
import { parseDmm } from '../src/dmm.js';
import { planEdit } from '../src/edit.js';
import { diffMaps, diffRegion, composeDiff, regionChanges } from '../src/diff.js';
import { loadDiff, renderDiff, gitShow } from '../src/diff-project.js';
import { loadRenderer } from '../src/render-project.js';
import { decodePng } from '../src/png.js';
import { ROOT, DME, MAP } from '../scripts/make-render-fixtures.js';

const DMM = '"a" = (/turf/floor,/area/a)\n"b" = (/obj/x,/obj/y,/turf/floor,/area/a)\n(1,1,1) = {"\naa\nba\n"}\n';
const sha = b => createHash('sha256').update(b).digest('hex');

test('an unchanged map, or one only re-keyed, has no changes', () => {
  assert.equal(diffMaps(parseDmm(DMM), parseDmm(DMM)).changedCells, 0);
  const rekeyed = '"q" = (/turf/floor, /area/a)\n"r" = (/obj/x,/obj/y,/turf/floor,/area/a)\n(1,1,1) = {"\nqq\nrq\n"}\n';
  assert.equal(diffMaps(parseDmm(DMM), parseDmm(rekeyed)).changedCells, 0);
});
test('changes report removed and added atoms as multisets, and reorders separately', () => {
  const after = '"a" = (/turf/floor,/area/a)\n"b" = (/obj/x,/obj/y,/turf/floor,/area/a)\n"c" = (/obj/y,/obj/x,/turf/floor,/area/a)\n"d" = (/obj/x,/obj/x{dir = 4},/turf/floor,/area/a)\n(1,1,1) = {"\nad\nca\n"}\n';
  const d = diffMaps(parseDmm(DMM), parseDmm(after));
  assert.equal(d.changedCells, 2);
  assert.deepEqual(d.cells.map(c => [c.x, c.y, c.change]), [[2, 2, 'modified'], [1, 1, 'reordered']].sort((p, q) => q[1] - p[1]));
  const mod = d.cells.find(c => c.change === 'modified');
  assert.deepEqual(mod.removed, []); assert.deepEqual(mod.added, ['/obj/x', '/obj/x{dir = 4}']);
  const re = d.cells.find(c => c.change === 'reordered');
  assert.deepEqual([re.removed, re.added], [[], []]);
  assert.deepEqual(d.types, [{ path: '/obj/x', removed: 0, added: 2 }]);
  assert.deepEqual(d.levels, [{ z: 1, changedCells: 2, x1: 1, y1: 1, x2: 2, y2: 2 }]);
});
test('holes on one side are added/removed cells and a world size change is flagged', () => {
  const wider = '"a" = (/turf/floor,/area/a)\n"b" = (/obj/x,/obj/y,/turf/floor,/area/a)\n(1,1,1) = {"\naaa\nbaa\n"}\n';
  const d = diffMaps(parseDmm(DMM), parseDmm(wider));
  assert.equal(d.world.changed, true);
  assert.deepEqual(d.cells.map(c => [c.x, c.y, c.change]), [[3, 2, 'added'], [3, 1, 'added']]);
  const back = diffMaps(parseDmm(wider), parseDmm(DMM));
  assert.deepEqual(back.cells.map(c => c.change), ['removed', 'removed']);
  assert.deepEqual(back.cells[0].removed, ['/turf/floor', '/area/a']);
});
test('the cell list is limited but counts and bounds stay complete', () => {
  const after = DMM.replace('aa\nba', 'bb\nab');
  const d = diffMaps(parseDmm(DMM), parseDmm(after), { limit: 1 });
  assert.equal(d.changedCells, 4); assert.equal(d.cells.length, 1); assert.equal(d.truncated, true);
  assert.deepEqual(d.levels[0], { z: 1, changedCells: 4, x1: 1, y1: 1, x2: 2, y2: 2 });
});
test('regionChanges lists every change in a region regardless of the diff limit', () => {
  const after = DMM.replace('aa\nba', 'bb\nab');
  assert.deepEqual(regionChanges(parseDmm(DMM), parseDmm(after), { x1: 1, y1: 1, x2: 2, y2: 2, z: 1 }).map(c => c.change), ['modified', 'modified', 'modified', 'modified']);
});
test('diffRegion pads, clamps to the world and caps the side length', () => {
  const d = { world: { before: { maxX: 100, maxY: 100 }, after: { maxX: 100, maxY: 100 } }, levels: [{ z: 2, x1: 1, y1: 50, x2: 90, y2: 52 }] };
  assert.deepEqual(diffRegion(d, { pad: 2, maxSide: 64 }), { x1: 1, y1: 48, x2: 64, y2: 54, z: 2, clipped: true });
  assert.equal(diffRegion(d, { z: 1 }), null);
});
test('composeDiff dims unchanged tiles and outlines changed ones by kind', () => {
  const solid = (w, h, v) => { const rgba = new Uint8Array(w * h * 4).fill(v); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; return { width: w, height: h, rgba }; };
  const before = solid(8, 4, 200), after = solid(8, 4, 200);
  const img = composeDiff(before, after, [{ x: 2, y: 1, z: 1, change: 'added' }], { x1: 1, y1: 1, x2: 2, y2: 1, z: 1 }, 4, { gap: 2 });
  assert.equal(img.width, 8 * 3 + 4); assert.equal(img.outlined, 1);
  const px = (x, y) => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
  const hx = img.panels.highlight.x;
  assert.deepEqual(px(1, 1), [200, 200, 200]); // before panel untouched
  assert.ok(px(hx + 1, 1)[0] < 100); // unchanged tile dimmed
  assert.deepEqual(px(hx + 4, 0), [40, 220, 80]); // green outline on the added tile
  assert.deepEqual(px(hx + 5, 1), [200, 200, 200]); // its inside keeps the after render
});

test('a dry-run patch diff renders three panels and never writes the map', async () => {
  const renderer = await loadRenderer({ root: ROOT, dme: DME, treeFile: 'fixtures/render/tree.xml' });
  const bytes = await readFile(path.join(ROOT, MAP));
  const patch = { base: sha(bytes), edits: [{ x: 2, y: 3, z: 1, expect: ['/turf/floor', '/area/zone'], set: ['/obj/tree', '/turf/floor', '/area/zone'] }] };
  const loaded = await loadDiff({ root: ROOT, map: MAP, patch });
  assert.equal(loaded.diff.changedCells, 1);
  assert.deepEqual(loaded.diff.cells[0].added, ['/obj/tree']);
  const r = await renderDiff(renderer, { root: ROOT, loaded, region: { x1: 1, y1: 1, x2: 3, y2: 3, z: 1 } });
  const img = decodePng(r.png);
  assert.equal(img.width, 3 * 3 * 8 + 8); assert.equal(img.height, 24); assert.equal(r.outlined, 1);
  assert.deepEqual(await readFile(path.join(ROOT, MAP)), bytes);
  await assert.rejects(loadDiff({ root: ROOT, map: MAP, patch: { ...patch, base: '0'.repeat(64) } }), /changed since/);
  await assert.rejects(loadDiff({ root: ROOT, map: MAP }), /exactly one/);
});

test('git revisions are read with git show, and unsafe revisions are refused', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bd-diff-'));
  try {
    const git = (...a) => { const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    git('init', '-q'); await mkdir(path.join(dir, 'maps'));
    await writeFile(path.join(dir, 'maps', 'm.dmm'), DMM); git('add', '.'); git('commit', '-qm', 'base');
    const edited = planEdit(DMM, { edits: [{ x: 1, y: 2, z: 1, expect: ['/turf/floor', '/area/a'], set: ['/turf/wall', '/area/a'] }] }).text;
    await writeFile(path.join(dir, 'maps', 'm.dmm'), edited);
    const loaded = await loadDiff({ root: dir, map: 'maps/m.dmm', gitRef: 'HEAD' });
    assert.deepEqual(loaded.diff.cells.map(c => [c.x, c.y, c.removed, c.added]), [[1, 2, ['/turf/floor'], ['/turf/wall']]]);
    for (const bad of ['--output=x', 'a..b', 'HEAD;rm', '']) assert.throws(() => gitShow(dir, 'maps/m.dmm', bad), /Invalid git revision/);
    const cli = spawnSync(process.execPath, ['src/cli.js', 'diff', '--root', dir, '--map', 'maps/m.dmm', '--git-ref', 'HEAD'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).data.changedCells, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

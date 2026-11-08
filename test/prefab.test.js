import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os'; import path from 'node:path';
import { parseDmm } from '../src/dmm.js';
import { planEdit } from '../src/edit.js';
import { extractPrefab, placePrefab, validatePrefab, PrefabError } from '../src/prefab.js';

const SRC = '"a" = (/turf/floor,/area/a)\n"b" = (/obj/table{dir = 4},/obj/lamp,/turf/wood,/area/house)\n"c" = (/mob/cat,/turf/wood,/area/house)\n(1,1,1) = {"\naaa\nabc\naaa\n"}\n';
const DST = '"x" = (/obj/rock,/turf/grass,/area/out)\n"y" = (/turf/grass,/area/out)\n(1,1,1) = {"\nyyyy\nyxyy\nyyyy\n"}\n';
const stack = (t, x, y) => parseDmm(t).inspectCell(x, y, 1).atoms.map(a => a.raw.trim());

test('extract keeps authored atom text, offsets from the south-west corner and chosen layers', () => {
  const p = extractPrefab(parseDmm(SRC), { x1: 2, y1: 2, x2: 3, y2: 2, z: 1, source: { map: 'm.dmm' } });
  assert.deepEqual(p.cells, [{ dx: 0, dy: 0, atoms: ['/obj/table{dir = 4}', '/obj/lamp', '/turf/wood', '/area/house'] }, { dx: 1, dy: 0, atoms: ['/mob/cat', '/turf/wood', '/area/house'] }]);
  assert.deepEqual(p.types, ['/area/house', '/mob/cat', '/obj/lamp', '/obj/table', '/turf/wood']);
  assert.deepEqual(p.source.region, { x1: 2, y1: 2, x2: 3, y2: 2, z: 1 });
  const movables = extractPrefab(parseDmm(SRC), { x1: 1, y1: 1, x2: 3, y2: 3, z: 1, layers: ['movable'] });
  assert.deepEqual(movables.cells.map(c => [c.dx, c.dy, c.atoms.length]), [[1, 1, 2], [2, 1, 1]]);
  assert.throws(() => extractPrefab(parseDmm(SRC), { x1: 1, y1: 1, x2: 3, y2: 3, z: 1, layers: ['obj'] }), PrefabError);
  assert.throws(() => extractPrefab(parseDmm(SRC), { x1: 1, y1: 1, x2: 4, y2: 3, z: 1 }), /outside/);
});
test('replace keeps the target area and turf where the prefab has none; overlay stacks movables', () => {
  const p = extractPrefab(parseDmm(SRC), { x1: 2, y1: 2, x2: 3, y2: 2, z: 1, layers: ['movable', 'turf'] });
  const map = parseDmm(DST);
  const r = placePrefab(map, p, { x: 2, y: 2, z: 1 });
  assert.deepEqual(r.edits.map(e => [e.x, e.y, e.set]), [[2, 2, ['/obj/table{dir = 4}', '/obj/lamp', '/turf/wood', '/area/out']], [3, 2, ['/mob/cat', '/turf/wood', '/area/out']]]);
  assert.deepEqual(r.bounds, { x1: 2, y1: 2, x2: 3, y2: 2, z: 1 });
  const o = placePrefab(map, extractPrefab(parseDmm(SRC), { x1: 2, y1: 2, x2: 2, y2: 2, z: 1, layers: ['movable'] }), { x: 2, y: 2, z: 1, mode: 'overlay' });
  assert.deepEqual(o.edits[0].set, ['/obj/rock', '/obj/table{dir = 4}', '/obj/lamp', '/turf/grass', '/area/out']);
});
test('a placement patch goes through planEdit, and placing it again changes nothing', () => {
  const p = extractPrefab(parseDmm(SRC), { x1: 1, y1: 1, x2: 3, y2: 3, z: 1 });
  const patch = placePrefab(parseDmm(DST), p, { x: 2, y: 1, z: 1 });
  const out = planEdit(DST, patch).text;
  assert.deepEqual(stack(out, 3, 2), ['/obj/table{dir = 4}', '/obj/lamp', '/turf/wood', '/area/house']);
  assert.deepEqual(stack(out, 1, 2), stack(DST, 1, 2)); // outside the prefab
  const again = placePrefab(parseDmm(out), p, { x: 2, y: 1, z: 1 });
  assert.equal(again.edits.length, 0); assert.equal(again.prefab.unchanged, 9);
});
test('placements that do not fit, and malformed prefabs, are refused', () => {
  const p = extractPrefab(parseDmm(SRC), { x1: 1, y1: 1, x2: 3, y2: 3, z: 1 });
  assert.throws(() => placePrefab(parseDmm(DST), p, { x: 3, y: 1, z: 1 }), /does not fit/);
  assert.throws(() => validatePrefab({ ...p, cells: [{ dx: 5, dy: 0, atoms: ['/turf/x'] }] }), /outside/);
  assert.throws(() => validatePrefab({ ...p, cells: [{ dx: 0, dy: 0, atoms: ['/area/a', '/area/b'] }] }), /more than one area/);
  assert.throws(() => validatePrefab({ ...p, kind: 'x' }), /Not a byond-devtools prefab/);
  assert.throws(() => placePrefab(parseDmm(DST), p, { x: 1, y: 1, z: 1, mode: 'merge' }), /mode/);
});
test('CLI: extract, place and apply through edit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bd-prefab-'));
  try {
    await mkdir(path.join(dir, 'maps')); await writeFile(path.join(dir, 'maps', 'src.dmm'), SRC); await writeFile(path.join(dir, 'maps', 'dst.dmm'), DST);
    const run = (...a) => { const r = spawnSync(process.execPath, ['src/cli.js', ...a, '--root', dir], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
    const pf = path.join(dir, 'house.json'), patch = path.join(dir, 'patch.json');
    run('prefab-extract', '--map', 'maps/src.dmm', '--x1', '2', '--y1', '2', '--x2', '3', '--y2', '2', '--z', '1', '--out', pf);
    const placed = run('prefab-place', '--map', 'maps/dst.dmm', '--prefab', pf, '--x', '1', '--y', '3', '--z', '1', '--out', patch);
    assert.equal(placed.data.edits, 2);
    const p = JSON.parse(await readFile(patch, 'utf8'));
    assert.equal(p.base, createHash('sha256').update(DST).digest('hex'));
    run('edit', '--map', 'maps/dst.dmm', '--patch', patch, '--apply');
    assert.deepEqual(stack(await readFile(path.join(dir, 'maps', 'dst.dmm'), 'utf8'), 2, 3), ['/mob/cat', '/turf/wood', '/area/house']);
    const again = spawnSync(process.execPath, ['src/cli.js', 'prefab-extract', '--root', dir, '--map', 'maps/src.dmm', '--x1', '1', '--y1', '1', '--x2', '1', '--y2', '1', '--z', '1', '--out', pf], { encoding: 'utf8' });
    assert.equal(again.status, 1); assert.match(again.stderr, /exists/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

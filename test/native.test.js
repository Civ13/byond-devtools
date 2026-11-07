import test from 'node:test'; import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises'; import path from 'node:path';
import { parseDmm } from '../src/dmm.js';
import { compareWorld, expectedCell, literalOverrides, overrideAssignments } from '../src/world.js';
import { harnessSource, mapTypePaths, recordNative } from '../src/native.js';
const dir = 'fixtures/native';
const fixtures = (await readdir(dir)).filter(f => f.endsWith('.dmm')).sort();
const load = async f => { const text = await readFile(path.join(dir, f), 'utf8'); return { text, map: parseDmm(text) }; };
const recorded = async f => JSON.parse(await readFile(path.join(dir, f.replace(/\.dmm$/, '.native.json')), 'utf8'));

test('every native fixture has a recording from the pinned BYOND build', async () => {
  assert.ok(fixtures.length >= 6);
  for (const f of fixtures) assert.equal((await recorded(f)).byond, '516.1688', f);
});
for (const f of fixtures) test(`parser agrees with recorded DreamDaemon world: ${f}`, async () => {
  const { map } = await load(f), r = compareWorld(map, await recorded(f));
  assert.equal(r.agree, true, JSON.stringify(r.differences)); assert.ok(r.cells > 0);
});
test('comparison detects a wrong turf, a wrong order and a wrong size', async () => {
  const { map } = await load('stacks.dmm'), dump = await recorded('stacks.dmm');
  const turf = structuredClone(dump); turf.cells[0][0] = '/turf/other';
  assert.equal(compareWorld(map, turf).differences[0].field, 'turf');
  const order = structuredClone(dump); const cell = order.cells.find(c => c[4].length > 1); cell[4].reverse();
  assert.equal(compareWorld(map, order).agree, false);
  const size = structuredClone(dump); size.maxy++;
  assert.equal(compareWorld(map, size).differences[0].field, 'maxy');
});
test('bottom-up offset placement would disagree with BYOND', async () => {
  // offset_blocks.dmm: header (1,3) rows a,b and header (1,1) row c. BYOND puts c on top.
  const { map } = await load('offset_blocks.dmm'), dump = await recorded('offset_blocks.dmm');
  assert.equal(map.inspectCell(1, 4, 1).atoms[0].path, '/turf/floor'); assert.equal(dump.cells[3][0], '/turf/floor');
  assert.equal(dump.cells[0][1], '/area/b');
});
test('cell rules: last turf wins, mobs after objs, defaults for missing turf/area', () => {
  const m = parseDmm('"a"=(/mob/m,/obj/o,/turf/t1,/turf/t2,/area/a)\n"b"=(/obj/o)\n(1,1,1)={"\nab\n"}');
  const a = expectedCell(m.inspectCell(1, 1, 1).atoms), b = expectedCell(m.inspectCell(2, 1, 1).atoms);
  assert.deepEqual([a.turf, a.area, a.underlays, a.contents.map(c => c.type)], ['/turf/t2', '/area/a', 1, ['/obj/o', '/mob/m']]);
  assert.deepEqual([b.turf, b.area], ['/turf', '/area']);
});
test('override literals: integers, plain strings, normalised colors; expressions skipped', () => {
  const o = literalOverrides('{a = 3; b = "x;y"; color = "#ABCDEF"; w = "#FFFFFF"; e = 1+2; s = "[x]"; f = 1.5}');
  assert.deepEqual(o.map(x => [x.key, x.expected]), [['a', '3'], ['b', 'x;y'], ['color', '#abcdef'], ['w', '#FFFFFF']]);
  assert.equal(literalOverrides('{color = "#FFFFFF"}')[0].expected, '');
  assert.equal(overrideAssignments('{e = 1+2; p = /obj/x}').length, 2);
});
test('multiple areas in a tile are reported as a compile error, not repaired', () => {
  const m = parseDmm('"a"=(/turf/t,/area/a,/area/b)\n(1,1,1)={"\na\n"}');
  assert.equal(m.diagnostics[0].code, 'multiple-areas'); assert.equal(m.summary().diagnostics.length, 1);
});
test('harness declares custom vars and stub types, never game code', async () => {
  const { map } = await load('stacks.dmm'), src = harnessSource(map, 'map.dmm', { resourceRoot: '/x/y' });
  assert.match(src, /^\/atom\/var\/custom_flag$/m); assert.match(src, /^\/atom\/var\/marker_ref$/m);
  assert.doesNotMatch(src, /^\/atom\/var\/name$/m); assert.match(src, /#define FILE_DIR "\/x\/y"/);
  assert.ok(mapTypePaths(map).includes('/obj/marker')); assert.match(src, /^\/mob\/dummy\/other$/m);
  assert.doesNotMatch(mapTypePaths(parseDmm('"a"=(/obj/o{n = "/obj/notatype"})\n(1,1,1)={"\na\n"}')).join(), /notatype/);
});
const bin = process.env.BYOND_BIN;
test('live DreamDaemon run matches the parser (set BYOND_BIN to run)', { skip: bin ? false : 'BYOND_BIN not set' }, async () => {
  for (const f of fixtures) {
    const { text, map } = await load(f), native = await recordNative(map, text, { binDir: bin });
    assert.equal(native.status, 'ok', native.compiler);
    const r = compareWorld(map, native.dump); assert.equal(r.agree, true, `${f}: ${JSON.stringify(r.differences)}`);
  }
});

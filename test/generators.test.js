import test from 'node:test'; import assert from 'node:assert/strict';
import { parseDmm } from '../src/dmm.js';
import { parseTypeTree } from '../src/typetree.js';
import { findGenerators, parseTypeList, markTiles, GENERATOR_PROFILES } from '../src/generators.js';

// A hand-written `DreamMaker -o` tree and the source lines its file= attributes point at.
const SRC = {
  'code/s.dm': [
    '/obj/effect/spawner',          // 1
    '\tvar/max_range = 10',          // 2
    '/obj/effect/spawner/loot',      // 3
    '\tvar/list/loot = list(/obj/sword = 3, /obj/axe = 1)', // 4
    '\tvar/nr = 2',                  // 5
    '/obj/effect/spawner/mob',       // 6
    '\tvar/create_path = /mob/wolf', // 7
    '\tvar/list/pack = list(',       // 8
    '\t\t/mob/wolf,',                // 9
    '\t\t/mob/ghost)',               // 10
    '\tvar/odd = pick(/mob/wolf)',   // 11
    '\tname = "wolf spawner"',       // 12
  ],
};
const XML = `<?xml version="1.0"?><dm>
<obj file="code/s.dm:1">obj
 <obj file="code/s.dm:1">effect
  <obj file="code/s.dm:1">spawner<var file="code/s.dm:2">max_range<val file="code/s.dm:2">10</val></var>
   <obj file="code/s.dm:3">loot<var file="code/s.dm:4">loot<val file="code/s.dm:4">/obj/sword/obj/axe</val></var><var file="code/s.dm:5">nr<val file="code/s.dm:5">2</val></var><proc file="code/s.dm:3">New</proc></obj>
   <obj file="code/s.dm:6">mob<var file="code/s.dm:7">create_path<val file="code/s.dm:7">/mob/wolf</val></var><var file="code/s.dm:8">pack<val file="code/s.dm:8"><list>list</list></val></var><var file="code/s.dm:11">odd<val file="code/s.dm:11">pick</val></var><var file="code/s.dm:12">name<val file="code/s.dm:12">"wolf spawner"</val></var><proc file="code/s.dm:6">Initialize</proc></obj>
  </obj>
 </obj>
 <obj file="code/s.dm:1">sword</obj><obj file="code/s.dm:1">axe</obj>
</obj>
<mob file="code/s.dm:1">mob<mob file="code/s.dm:1">wolf</mob></mob>
<turf file="code/s.dm:1">turf</turf><area file="code/s.dm:1">area</area>
</dm>`;
const tree = parseTypeTree(XML);
const sourceLine = (file, line) => SRC[file]?.[line - 1] ?? null;
const MAP = '"a" = (/turf,/area)\n"b" = (/obj/effect/spawner/loot,/turf,/area)\n"c" = (/obj/effect/spawner/mob{create_path = /mob/ghost; max_range = 3},/turf,/area)\n(1,1,1) = {"\nabc\nbaa\n"}\n';

test('parseTypeList reads paths, lists and pickweight lists, and nothing else', () => {
  assert.deepEqual(parseTypeList('/obj/x'), { types: [{ path: '/obj/x', weight: null }] });
  assert.deepEqual(parseTypeList('list(/obj/a = 3, /obj/b)'), { types: [{ path: '/obj/a', weight: 3 }, { path: '/obj/b', weight: null }] });
  for (const raw of ['pick(/obj/a)', 'list(/obj/a, "x")', 'list()', '"x"', 'list(/obj/a']) assert.equal(parseTypeList(raw), null, raw);
});
test('procOwner names the nearest type defining a proc', () => {
  assert.equal(tree.procOwner('/obj/effect/spawner/loot', 'New'), '/obj/effect/spawner/loot');
  assert.equal(tree.procOwner('/obj/effect/spawner', 'New'), null);
  assert.deepEqual(tree.get('/obj/effect/spawner/mob').procNames, ['Initialize']);
});
test('generators are found by root type, with spawn targets, settings and init procs', () => {
  const r = findGenerators(parseDmm(MAP), tree, sourceLine, { roots: ['/obj/effect/spawner'] });
  assert.equal(r.instanceCount, 3);
  const loot = r.generators.find(g => g.path === '/obj/effect/spawner/loot');
  assert.equal(loot.instances, 2);
  assert.deepEqual(loot.spawns, [{ var: 'loot', from: '/obj/effect/spawner/loot', types: [{ path: '/obj/sword', weight: 3, known: true }, { path: '/obj/axe', weight: 1, known: true }] }]);
  assert.deepEqual(loot.settings, { max_range: 10, nr: 2 });
  assert.deepEqual(loot.initProcs, [{ proc: 'New', definedIn: '/obj/effect/spawner/loot' }]);
  const mob = r.generators.find(g => g.path === '/obj/effect/spawner/mob');
  // The map override wins over the type's create_path; a multi-line list is read across lines.
  assert.deepEqual(mob.spawns.map(s => [s.var, s.from, s.types.map(t => `${t.path}:${t.known}`)]),
    [['create_path', 'map', ['/mob/ghost:false']], ['pack', '/obj/effect/spawner/mob', ['/mob/wolf:true', '/mob/ghost:false']]]);
  assert.deepEqual(mob.settings, { max_range: 3 });
  assert.deepEqual(mob.unresolved, [{ var: 'odd', raw: 'pick(/mob/wolf)' }]);
  assert.deepEqual(r.instances.map(i => `${i.x},${i.y}`).sort(), ['1,1', '2,2', '3,2']);
});
test('z filter, limits, unknown roots and the default profile', () => {
  const r = findGenerators(parseDmm(MAP), tree, sourceLine, { roots: ['/obj/effect/spawner/mob', '/obj/nothing'], limit: 0 });
  assert.equal(r.instanceCount, 1); assert.equal(r.truncated, true); assert.deepEqual(r.unknownRoots, ['/obj/nothing']);
  assert.equal(findGenerators(parseDmm(MAP), tree, sourceLine, { z: 2 }).instanceCount, 0);
  assert.ok(GENERATOR_PROFILES.civ13.roots.includes('/obj/effect/landmark'));
  assert.throws(() => findGenerators(parseDmm(MAP), tree, sourceLine, { roots: ['obj'] }), /type paths/);
});
test('markTiles outlines tiles inside the region only', () => {
  const img = { width: 8, height: 4, rgba: new Uint8Array(8 * 4 * 4) };
  assert.equal(markTiles(img, [{ x: 2, y: 1, z: 1 }, { x: 9, y: 1, z: 1 }, { x: 2, y: 1, z: 1 }], { x1: 1, y1: 1, x2: 2, y2: 1, z: 1 }, 4), 1);
  assert.deepEqual([...img.rgba.subarray((0 * 8 + 4) * 4, (0 * 8 + 4) * 4 + 4)], [0, 230, 255, 255]);
  assert.deepEqual([...img.rgba.subarray((1 * 8 + 5) * 4, (1 * 8 + 5) * 4 + 4)], [0, 0, 0, 0]);
});

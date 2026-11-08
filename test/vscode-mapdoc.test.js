import test from 'node:test'; import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openMapModel, placeAtom, eraseTop } from '../vscode/lib/mapdoc.mjs';
import { coreDir } from '../vscode/lib/session.mjs';
import { editMapFile } from '../src/edit-project.js';
import { parseDmm } from '../src/dmm.js';

const text = await readFile('fixtures/render/project/maps/render.dmm', 'utf8');
const core = coreDir(path.resolve('vscode/lib'));
const stack = (m, x, y) => m.stackAt(x, y, 1);

test('stack helpers put movables on top, replace turfs and areas, and erase the top object', () => {
  const s = ['/obj/a', '/turf/floor', '/area/zone'];
  assert.deepEqual(placeAtom(s, '/obj/b{dir = 4}'), ['/obj/a', '/obj/b{dir = 4}', '/turf/floor', '/area/zone']);
  assert.deepEqual(placeAtom(s, '/mob/m'), ['/obj/a', '/mob/m', '/turf/floor', '/area/zone']);
  assert.deepEqual(placeAtom(s, '/turf/wall'), ['/obj/a', '/turf/wall', '/area/zone']);
  assert.deepEqual(placeAtom(s, '/area/other'), ['/obj/a', '/turf/floor', '/area/other']);
  assert.deepEqual(placeAtom(['/turf/floor'], '/area/new'), ['/turf/floor', '/area/new']);
  assert.deepEqual(eraseTop(['/obj/a', '/mob/m', '/turf/floor', '/area/zone']), ['/obj/a', '/turf/floor', '/area/zone']);
  assert.equal(eraseTop(['/turf/floor', '/area/zone']), null);
});

test('edits, undo and redo go through planEdit and keep every other cell', async () => {
  const m = await openMapModel({ text, core });
  assert.equal(m.isDirty(), false);
  const placed = m.place([{ x: 1, y: 1, z: 1 }, { x: 2, y: 1, z: 1 }], '/obj/tree');
  assert.deepEqual(stack(m, 1, 1), ['/obj/box{color = rgb(0,0,255)}', '/obj/tree', '/turf/floor', '/area/zone']);
  assert.equal(m.isDirty(), true);
  assert.deepEqual(m.savePatch().edits.map(e => [e.x, e.y]), [[1, 1], [2, 1]]);
  m.setCells(placed.before);
  assert.equal(m.isDirty(), false);
  m.setCells(placed.after);
  assert.deepEqual(stack(m, 2, 1), ['/obj/tree', '/turf/floor/grass', '/area/zone']);
  assert.equal(m.erase([{ x: 2, y: 2, z: 1 }]).after[0].set.length, 3);
  // A var edit through a whole-stack set, and moving an object between tiles.
  m.setCells([{ x: 3, y: 1, z: 1, set: ['/obj/box{dir = 8; name = "crate"}', '/turf/floor', '/area/zone'] }]);
  assert.deepEqual(stack(m, 3, 1), ['/obj/box{dir = 8; name = "crate"}', '/turf/floor', '/area/zone']);
  const moved = m.move({ x: 3, y: 1, z: 1 }, 0, { x: 3, y: 3, z: 1 });
  assert.deepEqual(stack(m, 3, 1), ['/turf/floor', '/area/zone']);
  assert.deepEqual(stack(m, 3, 3), ['/obj/tree', '/obj/box{dir = 8; name = "crate"}', '/turf/floor', '/area/zone']);
  assert.equal(moved.before.length, 2);
  assert.throws(() => m.move({ x: 3, y: 3, z: 1 }, 2, { x: 1, y: 1, z: 1 }), /Only objects and mobs/);
  assert.throws(() => m.setCells([{ x: 1, y: 1, z: 1, set: ['/turf/floor', '/area/a', '/area/b'] }]), /more than one area/);
  assert.throws(() => m.setCells([{ x: 9, y: 9, z: 1, set: ['/turf/floor'] }]), /No authored cell/);
  assert.throws(() => m.setCells([{ x: 1, y: 1, z: 1, set: [] }]), /empty/);
  assert.equal(m.stamp([{ x: 1, y: 1, z: 1 }], stack(m, 1, 1)), null, 'a no-op edit is not recorded');
});

test('saving writes one safe-edit patch whose result matches the edited stacks', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mapdoc-'));
  try {
    await writeFile(path.join(dir, 'm.dmm'), text);
    const m = await openMapModel({ text, core });
    m.place([{ x: 1, y: 3, z: 1 }], '/obj/box{dir = 2}');
    const undone = m.erase([{ x: 3, y: 3, z: 1 }]); m.setCells(undone.before); // edited and undone: not written
    m.place([{ x: 3, y: 2, z: 1 }], '/turf/floor/grass');
    const patch = m.savePatch();
    assert.deepEqual(patch.edits.map(e => [e.x, e.y]), [[1, 3], [3, 2]]);
    const base = createHash('sha256').update(text).digest('hex');
    const r = await editMapFile({ root: dir, map: 'm.dmm', patch: { base, ...patch }, apply: true });
    assert.equal(r.applied, true);
    const saved = await readFile(path.join(dir, 'm.dmm'), 'utf8'), after = parseDmm(saved), before = parseDmm(text);
    for (const c of after.cells()) {
      const want = m.map.inspectCell(c.x, c.y, c.z).atoms.map(a => a.raw.trim()).join(',');
      assert.equal(c.atoms.map(a => a.raw.trim()).join(','), want, `${c.x},${c.y}`);
    }
    assert.equal(before.inspectCell(2, 2, 1).key, after.inspectCell(2, 2, 1).key, 'untouched cells keep their keys');
    m.reset(saved);
    assert.equal(m.isDirty(), false);
    // A stale base (the file changed after opening) is refused, nothing is written.
    m.place([{ x: 2, y: 2, z: 1 }], '/obj/tree');
    await assert.rejects(editMapFile({ root: dir, map: 'm.dmm', patch: { base, ...m.savePatch() }, apply: true }), /Map changed since/);
    assert.equal(await readFile(path.join(dir, 'm.dmm'), 'utf8'), saved);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a restored backup is dirty against the file and saves as a patch', async () => {
  const m = await openMapModel({ text, core });
  m.place([{ x: 2, y: 2, z: 1 }], '/obj/tree');
  const backup = m.text, r = await openMapModel({ text, core });
  r.restore(text, backup);
  assert.equal(r.isDirty(), true);
  assert.deepEqual(r.savePatch().edits.map(e => e.set), [stack(m, 2, 2)]);
});

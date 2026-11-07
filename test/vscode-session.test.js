import test from 'node:test'; import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openSession, coreDir, MAX_VIEW_TILES } from '../vscode/lib/session.mjs';
import { decodePng } from '../src/png.js';

const ROOT = 'fixtures/render/project';
const text = await readFile(`${ROOT}/maps/render.dmm`, 'utf8');
const core = coreDir(path.resolve('vscode/lib'));

test('the viewer session summarises, inspects and renders the golden image', async () => {
  const s = await openSession({ text, root: ROOT, mapRelative: 'maps/render.dmm', dme: 'render.dme', treeFile: 'fixtures/render/tree.xml', core });
  assert.deepEqual(s.summary().world, { maxX: 3, maxY: 3, maxZ: 1 });
  assert.deepEqual(s.inspect(3, 1, 1).atoms.map(a => a.path), ['/obj/box', '/turf/floor', '/area/zone']);
  assert.deepEqual(s.inspect(9, 9, 1).atoms, []);
  const r = await s.render({ x1: 1, y1: 1, x2: 3, y2: 3, z: 1 });
  assert.deepEqual(decodePng(Buffer.from(r.png, 'base64')).rgba, decodePng(await readFile('fixtures/render/golden.png')).rgba);
  const clipped = await s.render({ x1: 2, y1: 2, x2: 50, y2: 50, z: 1 });
  assert.deepEqual(clipped.region, { x1: 2, y1: 2, x2: 3, y2: 3, z: 1 });
  await assert.rejects(s.render({ x1: 1, y1: 1, x2: 3, y2: 3, z: 2 }), /outside the map/);
  assert.equal(MAX_VIEW_TILES, 4096);
});
test('without a type tree or BYOND the session explains what to configure', async () => {
  const s = await openSession({ text, root: ROOT, mapRelative: 'maps/render.dmm', dme: 'render.dme', core });
  assert.match((await s.render({ x1: 1, y1: 1, x2: 3, y2: 3, z: 1 })).error, /byondBin/);
  const n = await openSession({ text, root: ROOT, mapRelative: 'maps/render.dmm', dme: null, treeFile: 'x', core });
  assert.match((await n.render({ x1: 1, y1: 1, x2: 1, y2: 1, z: 1 })).error, /No \.dme/);
});

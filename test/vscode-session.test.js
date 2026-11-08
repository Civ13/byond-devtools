import test from 'node:test'; import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openSession, coreDir, MAX_VIEW_TILES } from '../vscode/lib/session.mjs';
import { decodePng, apngInfo } from '../src/png.js';
import { ANIMATION_FRAMES } from '../vscode/lib/session.mjs';

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
test('the editor view hides kinds, highlights a type and animates', async () => {
  const s = await openSession({ text, root: ROOT, mapRelative: 'maps/render.dmm', dme: 'render.dme', treeFile: 'fixtures/render/tree.xml', core });
  const full = decodePng(Buffer.from((await s.render({ x1: 1, y1: 1, x2: 3, y2: 3, z: 1 })).png, 'base64'));
  const turfs = await s.render({ x1: 1, y1: 1, x2: 3, y2: 3, z: 1, kinds: ['turf'] });
  assert.ok(turfs.diagnostics.some(d => d.code === 'filtered-out' && d.detail === '/obj/tree'));
  assert.notDeepEqual(decodePng(Buffer.from(turfs.png, 'base64')).rgba, full.rgba);
  const focus = await s.render({ x1: 1, y1: 1, x2: 3, y2: 3, z: 1, focus: '/obj/box/' });
  assert.equal(focus.focus, '/obj/box');
  const alphas = img => { const out = new Set(); for (let i = 3; i < img.rgba.length; i += 4) out.add(img.rgba[i]); return out; };
  const dimmed = decodePng(Buffer.from(focus.png, 'base64'));
  // Floors are dimmed to a quarter alpha; the boxes on top stay fully opaque.
  assert.ok(alphas(dimmed).has(64)); assert.ok(alphas(dimmed).has(255)); assert.ok(!alphas(full).has(64));
  const objs = decodePng(Buffer.from((await s.render({ x1: 1, y1: 1, x2: 3, y2: 3, z: 1, kinds: ['obj'], focus: '/obj/tree' })).png, 'base64'));
  assert.ok(alphas(objs).has(255), 'the tree is drawn at full alpha');
  const anim = await s.render({ x1: 1, y1: 1, x2: 3, y2: 3, z: 1, animate: true });
  assert.equal(apngInfo(Buffer.from(anim.png, 'base64')).frames, ANIMATION_FRAMES); assert.equal(anim.animation.frames, ANIMATION_FRAMES);
  assert.deepEqual(decodePng(Buffer.from(anim.png, 'base64')).rgba, full.rgba);
});
test('without a type tree or BYOND the session explains what to configure', async () => {
  const s = await openSession({ text, root: ROOT, mapRelative: 'maps/render.dmm', dme: 'render.dme', core });
  assert.match((await s.render({ x1: 1, y1: 1, x2: 3, y2: 3, z: 1 })).error, /byondBin/);
  const n = await openSession({ text, root: ROOT, mapRelative: 'maps/render.dmm', dme: null, treeFile: 'x', core });
  assert.match((await n.render({ x1: 1, y1: 1, x2: 1, y2: 1, z: 1 })).error, /No \.dme/);
});

test('compile and playtest reports become per-file problems', async () => {
  const { toDiagnostics, missingSetup } = await import('../vscode/lib/devrun.mjs');
  const m = toDiagnostics({ compile: { diagnostics: [{ file: 'code/a.dm', line: 3, severity: 'error', code: null, message: 'x: undefined var' }, { file: 'code/a.dm', line: 2, severity: 'warning', code: 'unused_var', message: 'unused' }] },
    runtime: { unique: [{ message: 'Cannot read null.v', proc: 'boom (/obj/t/proc/boom)', file: 'code/b.dm', line: 7, count: 3, callStack: ['t: boom()'] }, { message: 'no file', proc: null, file: null, line: null, count: 1, callStack: [] }] } });
  assert.deepEqual([...m.keys()], ['code/a.dm', 'code/b.dm']);
  assert.deepEqual(m.get('code/a.dm').map(d => [d.line, d.severity, d.code]), [[3, 'error', undefined], [2, 'warning', 'unused_var']]);
  assert.match(m.get('code/b.dm')[0].message, /^runtime error: Cannot read null\.v \(x3\)\nproc: boom/);
  assert.match(missingSetup({ dme: 'x.dme' }), /byondBin/); assert.equal(missingSetup({ dme: 'x.dme', byondBin: '/b' }), null);
});

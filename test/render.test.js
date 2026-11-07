import test from 'node:test'; import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os'; import path from 'node:path';
import { loadRenderer, renderMap } from '../src/render-project.js';
import { renderRegion, RENDER_VARS } from '../src/render.js';
import { decodePng } from '../src/png.js';
import { parseDmm } from '../src/dmm.js';
import { ICONS, ROOT, DME, MAP, TYPES } from '../scripts/make-render-fixtures.js';

const renderer = await loadRenderer({ root: ROOT, dme: DME, treeFile: 'fixtures/render/tree.xml' });
const native = JSON.parse(await readFile('fixtures/render/native-values.json', 'utf8'));
const { result, png } = await renderMap(renderer, { root: ROOT, map: MAP });
const px = (r, x, y) => [...r.rgba.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)];
const tile = (tx, ty, ix, iy) => [(tx - 1) * 8 + ix, (3 - ty) * 8 + iy]; // tile coords + offset from its top-left

test('fixture icons are reproducible from the generator', async () => {
  for (const [file, make] of Object.entries(ICONS)) assert.deepEqual(await readFile(`${ROOT}/${file}`), make(), file);
});
test('type-default appearances agree with DreamDaemon 516.1688 instance values', () => {
  assert.equal(native.byond, '516.1688');
  assert.equal(renderer.iconSize, 8); // world.icon_size from the type tree
  let checked = 0;
  for (const type of TYPES) {
    const ap = renderer.appearance({ path: type, overridesRaw: null });
    assert.deepEqual(ap.unresolved, [], type);
    for (const [name, value] of Object.entries(native.types[type])) {
      const got = name === 'icon' ? ap.icon?.resource : name === 'color' && ap.color === undefined ? null : ap[name];
      assert.deepEqual(got, value, `${type}.${name}`); checked++;
    }
  }
  assert.equal(checked, TYPES.length * 10);
});
test('golden render matches pixel for pixel', async () => {
  const golden = decodePng(await readFile('fixtures/render/golden.png'));
  assert.equal(golden.width, result.width); assert.equal(golden.height, result.height);
  assert.deepEqual(Buffer.from(golden.rgba), Buffer.from(result.rgba));
  assert.deepEqual(decodePng(png).rgba, golden.rgba);
});
test('layers, stacks, dirs, offsets, tints and anchoring are drawn as specified', () => {
  // (1,2): /obj/box/high (layer 5, dir S red) sits over /obj/box (layer 3, dir E cyan, pixel_x 2)
  // even though it comes first in the stack.
  assert.deepEqual(px(result, ...tile(1, 2, 0, 7)), [220, 40, 40, 255]);
  assert.deepEqual(px(result, ...tile(1, 2, 4, 7)), [40, 220, 220, 255]);
  assert.deepEqual(px(result, ...tile(1, 2, 6, 7)), [40, 160, 40, 255]);
  // (2,2): the mob (layer 4) is over the half-alpha white obj tinted #ff0000, which is over the floor.
  assert.deepEqual(px(result, ...tile(2, 2, 3, 3)), [40, 40, 230, 255]);
  const a = 128 / 255; // white * red at alpha 128 over grey 100
  assert.deepEqual(px(result, ...tile(2, 2, 0, 0)), [Math.round(255 * a + 100 * (1 - a)), Math.round(100 * (1 - a)), Math.round(100 * (1 - a)), 255]);
  // (3,1): a dir override picks the NORTH (yellow) frame.
  assert.deepEqual(px(result, ...tile(3, 1, 0, 7)), [230, 220, 40, 255]);
  // (3,3): a 16x16 icon on an 8px world is anchored at the tile's bottom-left.
  assert.deepEqual(px(result, ...tile(3, 3, 0, 0)), [120, 70, 20, 255]);
  // (1,3): an unknown type is a magenta/black placeholder, never a guess.
  assert.deepEqual(px(result, ...tile(1, 3, 0, 0)), [255, 0, 255, 255]);
  assert.deepEqual(px(result, ...tile(1, 3, 2, 0)), [0, 0, 0, 255]);
  // (3,2): the invisible obj is skipped and the missing state draws nothing: plain floor.
  assert.deepEqual(px(result, ...tile(3, 2, 1, 6)), [100, 100, 100, 255]);
});
test('everything not drawn exactly is in diagnostics', () => {
  assert.deepEqual(result.diagnostics.map(d => `${d.code} ${d.detail} ${d.count}`), [
    'approximate-var /obj/box.color 1', 'invisible-skipped /obj/ghost 1', 'missing-state icons/objs.dmi:nope 1', 'unknown-type /obj/nonexistent 1']);
  assert.equal(result.truthLayer, 'authored-source+type-defaults');
});
test('options: invisible atoms, sub-regions, grid and missing icon files', async () => {
  const shown = await renderMap(renderer, { root: ROOT, map: MAP, showInvisible: true, x1: 3, y1: 2, x2: 3, y2: 2 });
  assert.equal(shown.result.width, 8);
  assert.deepEqual(px(shown.result, 0, 7), [220, 40, 40, 255]);
  const grid = await renderMap(renderer, { root: ROOT, map: MAP, grid: 1, iconSize: 32 });
  assert.equal(grid.result.width, 96);
  assert.deepEqual(px(grid.result, 0, 5), [255, 255, 0, 255]); // grid line on x=1
  const map = parseDmm('"a" = (/obj/x,/turf)\n(1,1,1) = {"\na\n"}\n');
  const r = renderRegion(map, { x1: 1, y1: 1, x2: 1, y2: 1, z: 1, iconSize: 4, appearance: () => ({ icon: { resource: 'gone.dmi' }, icon_state: '', unresolved: [] }), icon: () => null });
  assert.deepEqual(r.diagnostics.map(d => d.code), ['missing-icon']);
  assert.deepEqual(px(r, 0, 0), [255, 0, 255, 255]);
});
test('equal layers draw south rows over north rows and later stack entries over earlier ones', () => {
  const map = parseDmm('"a" = (/obj/one,/obj/two,/turf)\n"b" = (/obj/tall,/turf)\n(1,1,1) = {"\na\nb\n"}\n');
  const colours = { '/obj/one': [255, 0, 0, 255], '/obj/two': [0, 255, 0, 255], '/obj/tall': [0, 0, 255, 255] };
  const fake = c => ({ width: 2, height: c === '/obj/tall' ? 4 : 2, findState: () => ({}), frame: () => { const n = c === '/obj/tall' ? 8 : 4; const o = new Uint8Array(n * 4); for (let i = 0; i < n; i++) o.set(colours[c], i * 4); return o; } });
  const r = renderRegion(map, { x1: 1, y1: 1, x2: 1, y2: 2, z: 1, iconSize: 2,
    appearance: a => a.path === '/turf' ? { icon: null, unresolved: [] } : { icon: { resource: a.path }, icon_state: '', layer: 3, unresolved: [] }, icon: fake });
  assert.deepEqual(px(r, 0, 0), [0, 0, 255, 255]); // the south tile's tall sprite covers the north tile
  r.rgba.fill(0);
  const north = renderRegion(map, { x1: 1, y1: 2, x2: 1, y2: 2, z: 1, iconSize: 2, appearance: a => a.path === '/turf' ? { icon: null, unresolved: [] } : { icon: { resource: a.path }, icon_state: '', layer: 3, unresolved: [] }, icon: fake });
  assert.deepEqual(px(north, 0, 0), [0, 255, 0, 255]); // /obj/two is later in the stack
});
test('limits and argument validation', () => {
  const map = parseDmm('"a" = (/turf)\n(1,1,1) = {"\na\n"}\n');
  const base = { z: 1, appearance: () => ({ icon: null, unresolved: [] }), icon: () => null };
  assert.throws(() => renderRegion(map, { ...base, x1: 0, y1: 1, x2: 1, y2: 1 }), TypeError);
  assert.throws(() => renderRegion(map, { ...base, x1: 2, y1: 1, x2: 1, y2: 1 }), RangeError);
  assert.throws(() => renderRegion(map, { ...base, x1: 1, y1: 1, x2: 200, y2: 200 }), /tile limit/);
  assert.throws(() => renderRegion(map, { ...base, x1: 1, y1: 1, x2: 100, y2: 100, iconSize: 64 }), /pixel limit/);
  assert.ok(RENDER_VARS.includes('pixel_w'));
});
test('CLI render writes one PNG, refuses to overwrite, and reports diagnostics', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'render-cli-')), out = path.join(dir, 'out.png');
  try {
    const args = ['src/cli.js', 'render', '--root', ROOT, '--dme', DME, '--map', MAP, '--tree', 'fixtures/render/tree.xml', '--out', out];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.data.diagnostics.length, 4);
    assert.deepEqual(decodePng(await readFile(out)).rgba, decodePng(await readFile('fixtures/render/golden.png')).rgba);
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
    assert.equal(spawnSync(process.execPath, [...args, '--force'], { encoding: 'utf8' }).status, 0);
    await writeFile(path.join(dir, 'x.txt'), '');
    const bad = spawnSync(process.execPath, [...args.slice(0, -1), path.join(dir, 'x.txt')], { encoding: 'utf8' });
    assert.match(bad.stderr, /\.png/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

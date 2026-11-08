import test from 'node:test'; import assert from 'node:assert/strict';
import { parseBackground, withBackground, scaleImage, drawBoxes, frameSheet, sideBySide, compareImages } from '../src/image.js';
import { atomFilter } from '../src/render.js';

const solid = (w, h, c) => { const rgba = new Uint8Array(w * h * 4); for (let i = 0; i < rgba.length; i += 4) rgba.set(c, i); return { width: w, height: h, rgba }; };

test('backgrounds parse and composite under transparent pixels only', () => {
  assert.equal(parseBackground('transparent'), null);
  assert.deepEqual(parseBackground('#102030'), [16, 32, 48, 255]);
  assert.throws(() => parseBackground('red'), /background must be/);
  const img = solid(2, 1, [0, 0, 0, 0]); img.rgba.set([255, 0, 0, 255], 4);
  const out = withBackground(img, [0, 0, 255, 255]);
  assert.deepEqual([...out.rgba], [0, 0, 255, 255, 255, 0, 0, 255]);
});

test('scale is nearest-neighbour and bounded', () => {
  const img = solid(2, 1, [1, 2, 3, 255]); img.rgba.set([9, 9, 9, 255], 4);
  const out = scaleImage(img, 2);
  assert.equal(out.width, 4); assert.equal(out.height, 2);
  assert.deepEqual([...out.rgba.subarray(8, 12)], [9, 9, 9, 255]);
  assert.throws(() => scaleImage(img, 9), /scale must be/);
});

test('boxes outline without touching the inside; sheets and panels lay out frames', () => {
  const img = solid(6, 6, [0, 0, 0, 0]);
  drawBoxes(img, [{ left: 0, top: 0, width: 6, height: 6, color: [255, 0, 255, 255] }]);
  assert.equal(img.rgba[3], 255); assert.equal(img.rgba[(2 * 6 + 2) * 4 + 3], 0);
  const sheet = frameSheet([solid(2, 2, [1, 1, 1, 255]).rgba, solid(2, 2, [2, 2, 2, 255]).rgba, null], { width: 2, height: 2, columns: 2 });
  assert.equal(sheet.width, 5); assert.equal(sheet.height, 5); assert.equal(sheet.rgba[(0 * 5 + 3) * 4], 2);
  assert.equal(sideBySide([solid(2, 2, [1, 1, 1, 255]), solid(3, 1, [1, 1, 1, 255])], 1).width, 6);
});

test('compare counts differing pixels over a threshold and outside the shared area', () => {
  const a = solid(3, 3, [100, 100, 100, 255]), b = solid(3, 3, [100, 100, 100, 255]);
  assert.equal(compareImages(a, b).differentPixels, 0);
  b.rgba.set([110, 100, 100, 255], (1 * 3 + 2) * 4);
  assert.equal(compareImages(a, b, { threshold: 10 }).differentPixels, 0);
  const c = compareImages(a, b, { threshold: 9, heatmap: true });
  assert.equal(c.differentPixels, 1); assert.deepEqual(c.bounds, { left: 2, top: 1, width: 1, height: 1 }); assert.equal(c.heatmap.rgba[(1 * 3 + 2) * 4], 255);
  const d = compareImages(a, solid(2, 3, [100, 100, 100, 255]));
  assert.equal(d.sameSize, false); assert.equal(d.differentPixels, 3);
});

test('atom filters keep, dim or hide by kind and type subtree', () => {
  const f = atomFilter({ kinds: ['obj', 'turf'], excludeTypes: ['/obj/box'], mode: 'dim' });
  assert.equal(f('/obj/tree', 'obj'), 'show'); assert.equal(f('/obj/box/high', 'obj'), 'dim'); assert.equal(f('/obj/boxer', 'obj'), 'show');
  assert.equal(f('/mob/man', 'mob'), 'dim');
  assert.equal(atomFilter({ types: ['/turf'] })('/obj/tree', 'obj'), 'hide');
  assert.equal(atomFilter(null)('/obj/x', 'obj'), 'show');
});

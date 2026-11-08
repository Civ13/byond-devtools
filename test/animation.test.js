import test from 'node:test'; import assert from 'node:assert/strict';
import { frameAt, frameSequence, decodeDmi } from '../src/dmi.js';
import { encodePng, encodeApng, apngInfo, decodePng } from '../src/png.js';
import { renderRegion } from '../src/render.js';
import { animatedDmi } from './helpers/animated-dmi.js';
import { parseDmm } from '../src/dmm.js';


test('frame timing follows BYOND delays, rewind and loop counts', () => {
  const st = { frames: 3, delay: [1, 2, 3], loop: 0, rewind: false };
  assert.deepEqual([0, 0.5, 1, 2.9, 3, 5.9, 6, 7].map(t => frameAt(st, t)), [1, 1, 2, 2, 3, 3, 1, 2]);
  const rw = { frames: 3, delay: [1, 1, 1], loop: 0, rewind: true };
  assert.deepEqual([0, 1, 2, 3, 4].map(t => frameAt(rw, t)), [1, 2, 3, 2, 1]);
  assert.deepEqual(frameSequence(rw).map(f => f.frame), [1, 2, 3, 2]);
  const once = { frames: 2, delay: null, loop: 1, rewind: false };
  assert.equal(frameAt(once, 1), 2); assert.equal(frameAt(once, 50), 2);
  assert.equal(frameAt({ frames: 1, delay: null }, 9), 1);
});

test('APNG encoding round-trips its control chunks and keeps frame 1 as the still image', () => {
  const red = new Uint8Array(4 * 4).fill(255), blue = new Uint8Array(4 * 4); for (let i = 0; i < 16; i += 4) { blue[i + 2] = 255; blue[i + 3] = 255; }
  const png = encodeApng([red, blue], { width: 2, height: 2, delaysMs: [100, 300], plays: 0, text: { Comment: 'x' } });
  assert.deepEqual(apngInfo(png), { frames: 2, plays: 0, delaysMs: [100, 300], fdat: 1 });
  assert.deepEqual(decodePng(png).rgba, red);
  assert.equal(apngInfo(encodePng({ width: 2, height: 2, rgba: red })), null);
  assert.throws(() => encodeApng([red], { width: 2, height: 2, delaysMs: [] }), /One delay per frame/);
});

test('a static render at a time shows the frame due then', () => {
  const dmi = decodeDmi(animatedDmi());
  const map = parseDmm('"a" = (/obj/anim,/turf/t,/area/a)\n\n(1,1,1) = {"\na\n"}\n');
  const appearance = a => a.path === '/obj/anim' ? { icon: { resource: 'anim.dmi' }, icon_state: 'spin', dir: 2, layer: 3, plane: 0, alpha: 255, unresolved: [] } : { icon: null, unresolved: [] };
  const at = timeDs => [...renderRegion(map, { x1: 1, y1: 1, x2: 1, y2: 1, z: 1, iconSize: 8, appearance, icon: () => dmi, timeDs }).rgba.subarray(0, 4)];
  assert.deepEqual(at(null), [255, 0, 0, 255]);
  assert.deepEqual(at(1), [0, 0, 255, 255]);
  assert.deepEqual(at(3.9), [0, 0, 255, 255]);
  assert.deepEqual(at(4), [255, 0, 0, 255]);
});

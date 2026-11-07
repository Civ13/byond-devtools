import test from 'node:test'; import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderIngame, colorMatrix, composeMatrix } from '../src/ingame-render.js';
import { probeSource, recordIngame, PROFILES } from '../src/ingame.js';
import { decodeDmi } from '../src/dmi.js';

const ROOT = 'fixtures/render/project';
const dump = JSON.parse(await readFile('fixtures/render/ingame.dump.json', 'utf8'));
const icons = dump.icons.map(i => decodeDmi(Buffer.from(i.base64, 'base64')));
const r = renderIngame(dump, icons);
const px = (x, y) => [...r.rgba.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)];

test('colour values become 20-entry matrices and compose in BYOND order', () => {
  assert.equal(colorMatrix(null), null); assert.equal(colorMatrix('#ffffff').length, 20);
  assert.deepEqual(colorMatrix('#ff000080').slice(0, 16), [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128 / 255]);
  assert.deepEqual(colorMatrix([0, 0, 1, 0, 1, 0, 1, 0, 0]).slice(0, 12), [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0]);
  assert.equal(colorMatrix('red'), undefined); assert.equal(colorMatrix([1, 2]), undefined);
  // Swap red/blue, then halve: red input ends as half blue.
  const m = composeMatrix(colorMatrix([0, 0, 1, 0, 1, 0, 1, 0, 0]), colorMatrix('#808080'));
  assert.ok(Math.abs(m[2] - 128 / 255) < 1e-9 && m[0] === 0);
});
test('the dump records runtime changes the static preview cannot see', () => {
  const types = Object.fromEntries(dump.cells.map(c => [`${c[0]},${c[1]}`, c]));
  assert.equal(dump.appearances[types['2,2'][3] - 1].icon_state, 'grass'); // icon_state changed in New()
  const box = dump.appearances[types['1,2'][4][0][0] - 1];
  assert.equal(box.overlays.length, 1); // overlay added in New()
  assert.deepEqual(dump.appearances[types['2,1'][4][0][0] - 1].transform, [0, 1, 0, -1, 0, 0]); // turn(matrix(), 90)
  assert.equal(dump.appearances[types['1,1'][4][0][0] - 1].color.length, 20); // runtime colour matrix
  assert.equal(dump.plane_masters.length, 1);
});
test('plane master multiply, overlays, transforms and invisibility compose as specified', () => {
  assert.deepEqual(r.diagnostics, []); assert.equal(r.drawn, 12);
  // Whole map is multiplied by the master's 0.5 "daylight"; floor 100 -> 50.
  assert.deepEqual(px(0, 0), [50, 50, 50, 255]);
  // (1,2): dir EAST box (cyan) at half light.
  assert.deepEqual(px(1, 7), [20, 110, 110, 255]);
  // (3,2): the lamp on the master's plane lifts its tile back to full light.
  assert.deepEqual(px(17, 7), [100, 100, 100, 255]);
  // (2,2): grass from New(), at half light.
  assert.deepEqual(px(9, 0), [20, 80, 20, 255]);
  // (2,1): box turned 90 degrees clockwise: its bottom-left square is now top-left, and the
  // overlay turns with it (vertical stripe becomes horizontal).
  assert.deepEqual(px(8, 8), [110, 20, 20, 255]);
  assert.deepEqual(px(12, 12), [20, 20, 115, 255]);
  // (3,1): the invisible obj is not drawn.
  assert.deepEqual(px(20, 12), [50, 50, 50, 255]);
  // (1,1): white at alpha 128 with a red/blue swap, over grey, at half light.
  assert.deepEqual(px(3, 12), [89, 89, 89, 255]);
});
test('probe source makes includes absolute, sets FILE_DIR, swaps the map and appends the profile', async () => {
  const src = await probeSource({ root: ROOT, dme: 'ingame.dme', profile: 'default' });
  assert.match(src.text, /#define FILE_DIR "(?:[A-Za-z]:)?\/.*fixtures\/render\/project"/);
  assert.match(src.text, /#include "(?:[A-Za-z]:)?\/.*fixtures\/render\/project\/code\/types\.dm"/);
  assert.doesNotMatch(src.text, /#include "code\//);
  assert.match(src.text, /proc\/profile_name\(\)\n\treturn "default"/);
  const swapped = await probeSource({ root: ROOT, dme: 'ingame.dme', map: 'maps/render.dmm' });
  assert.match(swapped.text, /maps\/render\.dmm"/); assert.doesNotMatch(swapped.text, /maps\/ingame\.dmm"/);
  await assert.rejects(probeSource({ root: ROOT, dme: 'ingame.dme', profile: 'nope' }), /Unknown profile/);
  assert.deepEqual(PROFILES, ['default', 'civ13']);
});
const bin = process.env.BYOND_BIN;
test('live: re-recording the fixture in DreamDaemon gives the checked-in dump (set BYOND_BIN to run)', { skip: bin ? false : 'BYOND_BIN not set' }, async () => {
  const run = await recordIngame({ root: ROOT, dme: 'ingame.dme', binDir: bin, region: { x1: 1, y1: 1, x2: 3, y2: 2, z: 1 }, settleDs: 5, timeoutMs: 120000 });
  assert.equal(run.status, 'ok', JSON.stringify(run));
  const { world_time, provenance, ...live } = run.dump, { provenance: p2, ...want } = dump;
  assert.deepEqual(live, want);
});

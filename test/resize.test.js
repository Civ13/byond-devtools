import test from 'node:test'; import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os'; import path from 'node:path';
import { planResize } from '../src/resize.js';
import { resizeMapFile } from '../src/edit-project.js';
import { EditError } from '../src/edit.js';
import { parseDmm } from '../src/dmm.js';

const DMM = '"a" = (/turf/floor,/area/a)\n"c" = (/obj/item{name = "x"},/turf/floor,/area/a)\n\n(1,1,1) = {"\naa\nca\n"}\n';
const FILL = ['/turf/space', '/area/space'];
const key = (text, x, y, z = 1) => parseDmm(text).inspectCell(x, y, z)?.key;
const sha = b => createHash('sha256').update(b).digest('hex');

test('growing keeps every cell, fills new space with a new key in order, and keeps the dictionary', () => {
  const r = planResize(DMM, { maxX: 3, maxY: 3, maxZ: 1, fill: FILL });
  assert.equal(r.text, '"a" = (/turf/floor,/area/a)\n"b" = (/turf/space,/area/space)\n"c" = (/obj/item{name = "x"},/turf/floor,/area/a)\n\n(1,1,1) = {"\nbbb\naab\ncab\n"}\n');
  assert.deepEqual({ before: r.before, after: r.after, kept: r.keptCells, filled: r.filledCells, cropped: r.croppedCells, fill: r.fillKey, newKeys: r.newKeys },
    { before: { maxX: 2, maxY: 2, maxZ: 1, cells: 4 }, after: { maxX: 3, maxY: 3, maxZ: 1, cells: 9 }, kept: 4, filled: 5, cropped: 0, fill: 'b', newKeys: ['b'] });
});
test('an offset moves the map, shrinking crops, and an existing stack is reused as the fill', () => {
  const grown = planResize(DMM, { maxX: 3, maxY: 2, maxZ: 1, offsetX: 1, fill: ['/turf/floor', ' /area/a '] });
  assert.equal(grown.fillKey, 'a'); assert.deepEqual(grown.newKeys, []);
  assert.equal(key(grown.text, 2, 1), 'c'); assert.equal(key(grown.text, 1, 1), 'a');
  const shrunk = planResize(DMM, { maxX: 1, maxY: 1, maxZ: 1 });
  assert.equal(shrunk.text, DMM.replace('aa\nca', 'c'));
  assert.equal(shrunk.croppedCells, 3); assert.deepEqual(shrunk.orphanedKeys, ['a']);
});
test('new levels are added in the map style; TGM gets one column per block', () => {
  const two = planResize(DMM, { maxX: 2, maxY: 2, maxZ: 2, fill: FILL });
  assert.match(two.text, /\n"}\n\n\(1,1,2\) = \{"\nbb\nbb\n"\}\n$/);
  const tgm = '"a" = (\n/turf/floor,\n/area/a)\n"c" = (\n/obj/item{\n\tname = "x"\n\t},\n/turf/floor,\n/area/a)\n\n(1,1,1) = {"\na\nc\n"}\n(2,1,1) = {"\na\na\n"}\n';
  const r = planResize(tgm, { maxX: 3, maxY: 2, maxZ: 1, fill: FILL });
  assert.equal(r.text, '"a" = (\n/turf/floor,\n/area/a)\n"b" = (\n/turf/space,\n/area/space)\n"c" = (\n/obj/item{\n\tname = "x"\n\t},\n/turf/floor,\n/area/a)\n\n(1,1,1) = {"\na\nc\n"}\n(2,1,1) = {"\na\na\n"}\n(3,1,1) = {"\nb\nb\n"}\n');
});
test('holes between blocks are filled, CRLF is kept, and bad specs change nothing', () => {
  const sparse = '"a" = (/turf/floor,/area/a)\r\n\r\n(1,1,1) = {"\r\na\r\n"}\r\n\r\n(3,1,1) = {"\r\na\r\n"}\r\n';
  const r = planResize(sparse, { fill: FILL });
  assert.equal(r.text, '"a" = (/turf/floor,/area/a)\r\n"b" = (/turf/space,/area/space)\r\n\r\n(1,1,1) = {"\r\naba\r\n"}\r\n');
  assert.throws(() => planResize(DMM, { maxX: 3 }), /fill must be a list/);
  assert.throws(() => planResize(DMM, { maxX: 3, fill: ['/turf/space'] }), /one turf and exactly one area/);
  assert.throws(() => planResize(DMM, { maxX: 0 }), EditError);
  assert.throws(() => planResize(DMM, { maxX: 1001 }), /from 1 to 1000/);
});
test('resizeMapFile is a dry run by default, checks base, and writes atomically with apply', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bd-resize-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'm.dmm'), DMM);
  const dry = await resizeMapFile({ root, map: 'm.dmm', spec: { maxX: 3, maxY: 3, maxZ: 1, fill: FILL } });
  assert.equal(dry.applied, false); assert.equal(await readFile(path.join(root, 'm.dmm'), 'utf8'), DMM);
  await assert.rejects(resizeMapFile({ root, map: 'm.dmm', spec: { base: '0'.repeat(64), maxX: 3, fill: FILL }, apply: true }), /Map changed/);
  const done = await resizeMapFile({ root, map: 'm.dmm', spec: { base: sha(Buffer.from(DMM)), maxX: 3, maxY: 3, maxZ: 1, fill: FILL }, apply: true });
  assert.equal(done.applied, true); assert.equal(sha(await readFile(path.join(root, 'm.dmm'))), done.newSha256);
  assert.equal(parseDmm(await readFile(path.join(root, 'm.dmm'), 'utf8')).world.maxX, 3);
});
test('the CLI resizes with a dry run and --apply', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bd-resize-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'm.dmm'), DMM);
  const cli = path.resolve('src/cli.js');
  const args = ['resize', '--root', root, '--map', 'm.dmm', '--max-x', '4', '--fill', '/turf/space,/area/space'];
  const dry = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).data.applied, false);
  assert.equal(JSON.parse(dry.stdout).data.after.maxX, 4);
  const wet = spawnSync(process.execPath, [cli, ...args, '--apply'], { encoding: 'utf8' });
  assert.equal(wet.status, 0, wet.stderr);
  assert.equal(parseDmm(await readFile(path.join(root, 'm.dmm'), 'utf8')).world.maxX, 4);
});
test('a map with every key taken is re-keyed one character wider before the fill is added', () => {
  const keys = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const full = keys.map((k, i) => `"${k}" = (/turf/t${i},/area/a)\n`).join('') + `\n(1,1,1) = {"\n${keys.join('')}\n"}\n`;
  const r = planResize(full, { maxX: 53, maxY: 1, maxZ: 1, fill: FILL });
  assert.deepEqual(r.widenedKeys, { from: 1, to: 2 });
  assert.equal(r.fillKey, 'ba'); assert.deepEqual(r.newKeys, ['ba']);
  const after = parseDmm(r.text);
  assert.equal(after.keyWidth, 2); assert.equal(after.definitions.length, 53);
  assert.equal(key(r.text, 1, 1), 'aa'); assert.equal(key(r.text, 52, 1), 'aZ'); assert.equal(key(r.text, 53, 1), 'ba');
  assert.equal(after.inspectCell(52, 1, 1).atoms[0].raw, '/turf/t51');
  assert.equal(r.keptCells, 52); assert.equal(r.filledCells, 1);
});

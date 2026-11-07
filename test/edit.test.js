import test from 'node:test'; import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os'; import path from 'node:path';
import { planEdit, compactAtom, EditError } from '../src/edit.js';
import { editMapFile } from '../src/edit-project.js';
import { parseDmm } from '../src/dmm.js';
import { recordNative } from '../src/native.js';
import { compareWorld } from '../src/world.js';

const DMM = '"a" = (/turf/floor,/area/a)\n"c" = (/obj/item{name = "x"},/turf/floor,/area/a)\n(1,1,1) = {"\naa\nca\n"}\n';
const stack = (text, x, y, z = 1) => parseDmm(text).inspectCell(x, y, z).atoms.map(a => a.raw.trim());
const sha = b => createHash('sha256').update(b).digest('hex');

test('a new stack gets the lowest free key, in key order, and only that grid key changes', () => {
  const r = planEdit(DMM, { edits: [{ x: 2, y: 2, z: 1, expect: ['/turf/floor', '/area/a'], set: ['/obj/item{dir = 4;name = "a; b"}', '/turf/floor', '/area/a'] }] });
  assert.equal(r.text, '"a" = (/turf/floor,/area/a)\n"b" = (/obj/item{dir = 4; name = "a; b"},/turf/floor,/area/a)\n"c" = (/obj/item{name = "x"},/turf/floor,/area/a)\n(1,1,1) = {"\nab\nca\n"}\n');
  assert.deepEqual(r.newKeys, ['b']); assert.deepEqual(r.orphanedKeys, []);
  assert.deepEqual(r.verified, { cells: 4, changedCells: 1, unchangedCells: 3, bytesBefore: DMM.length, bytesAfter: r.text.length });
});
test('an existing stack is reused regardless of whitespace, and orphaned keys are kept and reported', () => {
  const r = planEdit(DMM, { edits: [{ x: 1, y: 1, z: 1, expect: ['/obj/item{name="x";}', '/turf/floor', '/area/a'], set: ['/turf/floor', ' /area/a '] }] });
  assert.equal(r.text, DMM.replace('ca\n"}', 'aa\n"}'));
  assert.deepEqual(r.newKeys, []); assert.deepEqual(r.reusedKeys, ['a']); assert.deepEqual(r.orphanedKeys, ['c']);
  assert.match(r.text, /"c" = /); // never pruned
});
test('TGM style, CRLF line endings and every untouched byte are preserved', () => {
  const tgm = '//MAP CONVERTED BY dmm2tgm.py THIS HEADER COMMENT PREVENTS RECONVERSION, DO NOT REMOVE\r\n"a" = (\r\n/turf/floor,\r\n/area/a)\r\n\r\n(1,1,1) = {"\r\na\r\na\r\n"}\r\n(2,1,1) = {"\r\na\r\na\r\n"}\r\n';
  const r = planEdit(tgm, { edits: [{ x: 2, y: 1, z: 1, expect: ['/turf/floor', '/area/a'], set: ['/obj/item{name = "q";pixel_x = -4}', '/turf/floor', '/area/a'] }] });
  assert.equal(r.text, tgm.replace('/area/a)\r\n\r\n', '/area/a)\r\n"b" = (\r\n/obj/item{\r\n\tname = "q";\r\n\tpixel_x = -4\r\n\t},\r\n/turf/floor,\r\n/area/a)\r\n\r\n').replace(/a\r\n"}\r\n$/, 'b\r\n"}\r\n'));
  assert.deepEqual(stack(r.text, 2, 1), ['/obj/item{\r\n\tname = "q";\r\n\tpixel_x = -4\r\n\t}', '/turf/floor', '/area/a']);
});
test('the inverse patch restores every cell', () => {
  const r = planEdit(DMM, { edits: [{ x: 1, y: 2, z: 1, expect: ['/turf/floor', '/area/a'], set: ['/turf/wall', '/area/a'] }, { x: 1, y: 1, z: 1, expect: stack(DMM, 1, 1), set: ['/turf/floor', '/area/a'] }] });
  const back = planEdit(r.text, r.inverse);
  const cells = t => [...parseDmm(t).cells()].map(c => c.atoms.map(a => compactAtom(a.raw)).join());
  assert.deepEqual(cells(back.text), cells(DMM));
});
test('stale or unsafe patches fail and change nothing', () => {
  const edit = over => ({ edits: [{ x: 1, y: 2, z: 1, expect: ['/turf/floor', '/area/a'], set: ['/turf/wall', '/area/a'], ...over }] });
  const fails = (patch, pattern) => assert.throws(() => planEdit(DMM, patch), e => e instanceof EditError && pattern.test(e.message));
  fails(edit({ expect: ['/turf/wall', '/area/a'] }), /does not match expect/);
  fails(edit({ x: 3 }), /no authored cell/);
  fails(edit({ set: ['/turf/wall', '/area/a', '/area/b'] }), /more than one area/);
  fails(edit({ set: ['/obj/item{dir = 4; 5}', '/turf/floor', '/area/a'] }), /Unsupported override/);
  fails(edit({ set: ['/obj/item, /obj/x', '/area/a'] }), /one atom/);
  fails(edit({ set: [] }), /set may not be empty/);
  fails({ edits: [edit().edits[0], edit().edits[0]] }, /edited twice/);
  fails({ ...edit(), bounds: { x1: 2, y1: 1, x2: 2, y2: 2 } }, /outside the patch bounds/);
  fails({ ...edit(), maxEdits: 0 }, /limit is 0/);
  fails({ edits: [] }, /no edits/);
});
test('a full key space is refused rather than widening every key', () => {
  const keys = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const text = [...keys].map((k, i) => `"${k}" = (/turf/t${i},/area/a)`).join('\n') + `\n(1,1,1) = {"\n${keys}\n"}\n`;
  assert.throws(() => planEdit(text, { edits: [{ x: 1, y: 1, z: 1, expect: ['/turf/t0', '/area/a'], set: ['/turf/new', '/area/a'] }] }), /no free 1-character dictionary key/);
});
test('file apply: base hash, dry run, atomic replace, BOM kept, no temp files left', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'edit-file-')), file = path.join(dir, 'm.dmm');
  try {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(DMM)]); await writeFile(file, bytes);
    const patch = { base: sha(bytes), edits: [{ x: 1, y: 2, z: 1, expect: ['/turf/floor', '/area/a'], set: ['/turf/wall', '/area/a'] }] };
    const dry = await editMapFile({ root: dir, map: 'm.dmm', patch });
    assert.equal(dry.applied, false); assert.deepEqual(await readFile(file), bytes);
    const done = await editMapFile({ root: dir, map: 'm.dmm', patch, apply: true });
    const after = await readFile(file);
    assert.equal(done.applied, true); assert.equal(sha(after), done.newSha256); assert.equal(done.newSha256, dry.newSha256);
    assert.deepEqual(after.subarray(0, 3), bytes.subarray(0, 3));
    assert.deepEqual(await readdir(dir), ['m.dmm']);
    await assert.rejects(editMapFile({ root: dir, map: 'm.dmm', patch, apply: true }), /Map changed since the patch was made/);
    await assert.rejects(editMapFile({ root: dir, map: 'm.dmm', patch: { edits: [] } }), /base/);
    await assert.rejects(editMapFile({ root: dir, map: '../x.dmm', patch: { ...patch, base: done.newSha256 } }), /escapes project root|ENOENT/);
    const undo = await editMapFile({ root: dir, map: 'm.dmm', patch: done.inverse, apply: true });
    assert.equal(undo.applied, true);
    assert.deepEqual(stack((await readFile(file, 'utf8')).slice(1), 1, 2), ['/turf/floor', '/area/a']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('CLI edit: dry run by default, --apply writes, inverse file is never overwritten', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'edit-cli-'));
  try {
    await writeFile(path.join(dir, 'm.dmm'), DMM);
    const patch = { base: sha(Buffer.from(DMM)), edits: [{ x: 2, y: 1, z: 1, expect: ['/turf/floor', '/area/a'], set: ['/turf/wall', '/area/a'] }] };
    await writeFile(path.join(dir, 'p.json'), JSON.stringify(patch));
    const run = (...extra) => spawnSync(process.execPath, ['src/cli.js', 'edit', '--root', dir, '--map', 'm.dmm', '--patch', path.join(dir, 'p.json'), ...extra], { encoding: 'utf8' });
    const dry = run(); assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).data.applied, false); assert.equal(await readFile(path.join(dir, 'm.dmm'), 'utf8'), DMM);
    const inv = path.join(dir, 'inverse.json');
    const done = run('--apply', '--inverse-out', inv); assert.equal(done.status, 0, done.stderr);
    assert.equal(JSON.parse(await readFile(inv, 'utf8')).edits[0].set[0], '/turf/floor');
    const stale = run(); assert.equal(stale.status, 1); assert.match(stale.stderr, /actualSha256/);
    assert.equal(run('--inverse-out', inv).status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
const bin = process.env.BYOND_BIN;
test('an edited map loads in DreamDaemon exactly as the parser reads it (set BYOND_BIN to run)', { skip: bin ? false : 'BYOND_BIN not set' }, async () => {
  const text = await readFile('fixtures/native/stacks.dmm', 'utf8'), map = parseDmm(text);
  const r = planEdit(text, { edits: [
    { x: 1, y: 2, z: 1, expect: stack(text, 1, 2), set: ['/obj/item{name = "edited; ok"; pixel_x = 3}', '/mob/dummy', '/turf/floor', '/area/b'] },
    { x: 3, y: 1, z: 1, expect: stack(text, 3, 1), set: stack(text, 1, 1) },
    { x: 5, y: 1, z: 1, expect: stack(text, 5, 1), set: ['/obj/marker{color = "#ABCDEF"}', '/turf/wall', '/area/a'] }] });
  const edited = parseDmm(r.text), native = await recordNative(edited, r.text, { binDir: bin });
  assert.equal(native.status, 'ok', native.compiler);
  const cmp = compareWorld(edited, native.dump);
  assert.ok(cmp.agree, JSON.stringify(cmp.differences)); assert.ok(cmp.checkedOverrides > 5);
  assert.equal(map.world.maxX, edited.world.maxX);
});

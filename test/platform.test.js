import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readProjectFile } from '../src/project.js';
import { parseDmm } from '../src/dmm.js';
const win = process.platform === 'win32';

test('TGM fixture keeps column orientation and multi-line overrides', async () => {
  const m = parseDmm(await readFile('fixtures/tiny_tgm.dmm', 'utf8'));
  assert.equal(m.inspectCell(1, 2, 1).key, 'a'); assert.equal(m.inspectCell(2, 2, 1).key, 'b');
  assert.equal(m.inspectCell(2, 1, 1).key, 'a');
  assert.match(m.inspectCell(1, 2, 1).atoms[0].overridesRaw, /pixel_x = -4/);
});
test('whole-file CRLF (Windows checkout without eol=lf) parses identically', async () => {
  const lf = (await readFile('fixtures/tiny_tgm.dmm', 'utf8')).replaceAll('\r\n', '\n');
  const a = parseDmm(lf), b = parseDmm(lf.replaceAll('\n', '\r\n'));
  assert.deepEqual([...b.cells()].map(c => c.key), [...a.cells()].map(c => c.key));
});
test('many single-column TGM blocks use indexed lookup', () => {
  let s = '"a" = (\n/turf/a,\n/area/a)\n"b" = (\n/turf/b,\n/area/a)\n';
  for (let x = 1; x <= 3000; x++) s += `(${x},1,1) = {"\n${x % 2 ? 'a' : 'b'}\na\n"}\n`;
  const m = parseDmm(s);
  for (let x = 1; x <= 3000; x++) assert.equal(m.inspectCell(x, 2, 1).key, x % 2 ? 'a' : 'b');
  assert.equal(m.inspectCell(3001, 1, 1), null); assert.equal(m.inspectCell(1, 3, 1), null);
});
test('project reads reject absolute and other-drive paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byond-root-'));
  try {
    await mkdir(path.join(root, 'maps')); await writeFile(path.join(root, 'maps', 'x.dmm'), 'x');
    assert.equal((await readProjectFile(root, path.join('maps', 'x.dmm'))).relative, path.join('maps', 'x.dmm'));
    await assert.rejects(readProjectFile(root, path.resolve(root, 'maps', 'x.dmm')), /relative/);
    await assert.rejects(readProjectFile(root, '../outside.dmm'));
    if (win) {
      await assert.rejects(readProjectFile(root, 'C:\\Windows\\win.ini'), /relative/);
      await assert.rejects(readProjectFile(root, '\\\\server\\share\\x.dmm'), /relative/);
      // Drive-relative paths resolve against that drive's cwd, which is outside the root.
      await assert.rejects(readProjectFile(root, 'C:win.ini'));
      // Windows paths are case-insensitive; the same file under different case is still contained.
      assert.equal((await readProjectFile(root.toUpperCase(), 'MAPS\\X.DMM')).bytes, 1);
    }
  } finally { await rm(root, { recursive: true }); }
});
test('CLI accepts a root path with spaces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byond root with spaces-'));
  try {
    await writeFile(path.join(root, 'tiny.dmm'), await readFile('fixtures/tiny_tgm.dmm'));
    const r = spawnSync(process.execPath, ['src/cli.js', 'cell', '--root', root, '--map', 'tiny.dmm', '--x', '2', '--y', '1', '--z', '1'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).data.key, 'a');
  } finally { await rm(root, { recursive: true }); }
});
test('corpus script reports every map and fails on a bad one', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byond-corpus-'));
  try {
    await mkdir(path.join(root, 'maps', 'sub'), { recursive: true });
    await writeFile(path.join(root, 'maps', 'sub', 'good.dmm'), await readFile('fixtures/tiny.dmm'));
    let r = spawnSync(process.execPath, ['scripts/corpus.js', '--root', root], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).parsed, 1);
    await writeFile(path.join(root, 'maps', 'bad.dmm'), '"a"=(/turf/a)\n(1,1,1)={"\nb\n"}');
    r = spawnSync(process.execPath, ['scripts/corpus.js', '--root', root], { encoding: 'utf8' });
    const report = JSON.parse(r.stdout);
    assert.equal(r.status, 1); assert.equal(report.failures.length, 1); assert.equal(report.failures[0].file, 'maps/bad.dmm');
    r = spawnSync(process.execPath, ['scripts/corpus.js', '--root', root, '--expect-at-least', '5'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
  } finally { await rm(root, { recursive: true }); }
});

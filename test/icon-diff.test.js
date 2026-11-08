import test from 'node:test'; import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import { encodePng, decodePng } from '../src/png.js';
import { decodeDmi } from '../src/dmi.js';
import { diffIcons } from '../src/icon-diff.js';

/** An 8x8 DMI from [{name, colour, frames?}] states, one dir each. */
function dmi(states) {
  const cells = states.flatMap(s => Array.from({ length: s.frames ?? 1 }, () => s.colour));
  const width = 8 * cells.length, rgba = new Uint8Array(width * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < width; x++) rgba.set(cells[Math.floor(x / 8)], (y * width + x) * 4);
  const body = states.map(s => `state = "${s.name}"\n\tdirs = 1\n\tframes = ${s.frames ?? 1}\n${(s.frames ?? 1) > 1 ? `\tdelay = ${Array(s.frames).fill(1).join(',')}\n` : ''}`).join('');
  return encodePng({ width, height: 8, rgba }, { text: { Description: `# BEGIN DMI\nversion = 4.0\n\twidth = 8\n\theight = 8\n${body}# END DMI\n` } });
}
const red = [255, 0, 0, 255], blue = [0, 0, 255, 255], green = [0, 255, 0, 255];

test('diffIcons lists added, removed and changed states and draws the changed ones', () => {
  const before = decodeDmi(dmi([{ name: 'a', colour: red }, { name: 'b', colour: blue }, { name: 'gone', colour: green }]));
  const after = decodeDmi(dmi([{ name: 'a', colour: red }, { name: 'b', colour: green, frames: 2 }, { name: 'new', colour: blue }]));
  const d = diffIcons(before, after);
  assert.deepEqual(d.summary, { added: 1, removed: 1, changed: 1, same: 1, rowsShown: 3, rowsOmitted: 0, columns: ['before', 'after', 'heatmap'] });
  const b = d.states.find(s => s.state === 'b');
  assert.equal(b.change, 'changed'); assert.match(b.details, /frames 1 -> 2/); assert.match(b.details, /delays changed/); assert.match(b.details, /pixels differ/);
  assert.equal(d.states.find(s => s.state === 'a').change, 'same');
  // Rows: changed b (8x2 frames wide panels), then added, then removed; three panels side by side.
  assert.equal(d.image.width, 8 + 4 + 17 + 4 + 17); // b: one frame before, two after, heatmap as wide as the larger
  assert.equal(d.image.height, 8 * 3 + 6 * 2);
  const same = diffIcons(before, before);
  assert.equal(same.image, null); assert.equal(same.summary.changed, 0);
  assert.equal(diffIcons(null, after).summary.added, 3);
});

test('icon-diff CLI writes the review PNG and exits 3 on changes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bd-icondiff-'));
  try {
    await writeFile(path.join(dir, 'a.dmi'), dmi([{ name: 'a', colour: red }]));
    await writeFile(path.join(dir, 'b.dmi'), dmi([{ name: 'a', colour: blue }]));
    const run = (...args) => spawnSync(process.execPath, ['src/cli.js', 'icon-diff', ...args], { encoding: 'utf8' });
    const changed = run('--before', path.join(dir, 'a.dmi'), '--after', path.join(dir, 'b.dmi'), '--out', path.join(dir, 'd.png'));
    assert.equal(changed.status, 3, changed.stderr);
    const out = JSON.parse(changed.stdout).data;
    assert.equal(out.changed, 1); assert.equal(out.states[0].differentPixels, 64);
    assert.equal(decodePng(await readFile(path.join(dir, 'd.png'))).height, 8);
    assert.equal(run('--before', path.join(dir, 'a.dmi'), '--after', path.join(dir, 'a.dmi')).status, 0);
    assert.equal(JSON.parse(run('--before', 'none', '--after', path.join(dir, 'a.dmi')).stdout).data.added, 1);
    assert.equal(run('--before', 'none', '--after', 'none').status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

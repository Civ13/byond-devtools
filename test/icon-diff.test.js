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

test('icon_diff (agent API) compares a .dmi with a git revision or another file', async () => {
  const { createAgentApi } = await import('../src/agent-api.js');
  const { mkdir } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bd-icondiff-git-'));
  try {
    const git = (...a) => { const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    git('init', '-q'); const proj = path.join(dir, 'proj'); await mkdir(path.join(proj, 'icons'), { recursive: true }); // project below the repo root
    await writeFile(path.join(proj, 'icons', 'a.dmi'), dmi([{ name: 'a', colour: red }, { name: 'gone', colour: green }]));
    git('add', '.'); git('commit', '-qm', 'base');
    await writeFile(path.join(proj, 'icons', 'a.dmi'), dmi([{ name: 'a', colour: blue }, { name: 'new', colour: green }]));
    await writeFile(path.join(proj, 'icons', 'b.dmi'), dmi([{ name: 'a', colour: red }]));
    const api = createAgentApi({ root: proj });
    const d = await api.call('icon_diff', { dmi: 'icons/a.dmi', scale: 2 });
    assert.deepEqual([d.data.added, d.data.removed, d.data.changed], [1, 1, 1]);
    assert.deepEqual(d.provenance.before, { source: 'git', ref: 'HEAD', existed: true });
    assert.ok(d.png && decodePng(d.png).width === d.data.image.width && d.data.image.scale === 2);
    // New since the revision: every state is added.
    const fresh = await api.call('icon_diff', { dmi: 'icons/b.dmi' });
    assert.equal(fresh.provenance.before.existed, false); assert.equal(fresh.data.added, 1);
    // Against another file; identical files have no picture.
    const other = await api.call('icon_diff', { dmi: 'icons/b.dmi', before: 'icons/b.dmi' });
    assert.equal(other.data.same, 1); assert.equal(other.png, undefined); assert.equal(other.data.image, null);
    await assert.rejects(api.call('icon_diff', { dmi: 'icons/a.dmi', git_ref: 'a..b' }), /Invalid git revision/);
    await assert.rejects(api.call('icon_diff', { dmi: '../x.dmi' }), /escapes|ENOENT|no such/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

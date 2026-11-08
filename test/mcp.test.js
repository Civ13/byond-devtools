import test from 'node:test'; import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os'; import path from 'node:path';
import { createInterface } from 'node:readline';
import { decodePng, apngInfo } from '../src/png.js';
import { writeFile } from 'node:fs/promises';
import { animatedDmi } from './helpers/animated-dmi.js';
import { createAgentApi, TOOLS } from '../src/agent-api.js';

/** Start src/mcp.js on a copy of the render fixture project and talk to it over stdio. */
async function startServer(extra = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bd-mcp-'));
  await cp('fixtures/render/project', dir, { recursive: true });
  const proc = spawn(process.execPath, ['src/mcp.js', '--root', dir, '--dme', 'render.dme', '--tree', path.resolve('fixtures/render/tree.xml'), ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let next = 1;
  createInterface({ input: proc.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); });
  const request = (method, params) => new Promise(resolve => { const id = next++; waiting.set(id, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args) => { const r = await request('tools/call', { name, arguments: args }); return { ...r.result, json: JSON.parse(r.result.content[0].text) }; };
  return { dir, proc, request, call, async close() { proc.stdin.end(); await new Promise(r => proc.on('close', r)); await rm(dir, { recursive: true, force: true }); } };
}

test('initialize, tools/list and protocol errors', async () => {
  const s = await startServer();
  try {
    const init = await s.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-03-26'); assert.equal(init.result.serverInfo.name, 'byond-devtools');
    assert.equal((await s.request('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
    const list = await s.request('tools/list', {});
    assert.deepEqual(list.result.tools.map(t => t.name), TOOLS.map(t => t.name));
    assert.ok(list.result.tools.every(t => t.inputSchema.type === 'object'));
    assert.equal((await s.request('nope', {})).error.code, -32601);
    assert.equal((await s.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  } finally { await s.close(); }
});

test('read tools return JSON, renders return a PNG image, bad input is a tool error', async () => {
  const s = await startServer();
  try {
    const sum = await s.call('map_summary', { map: 'maps/render.dmm' });
    assert.equal(sum.isError, false); assert.deepEqual(sum.json.data.world, { maxX: 3, maxY: 3, maxZ: 1 });
    const cell = await s.call('map_cell', { map: 'maps/render.dmm', x: 1, y: 3, z: 1 });
    assert.deepEqual(cell.json.data.atoms.map(a => a.path), ['/obj/nonexistent', '/turf/floor', '/area/zone']);
    const render = await s.call('map_render', { map: 'maps/render.dmm', x1: 1, y1: 1, x2: 3, y2: 3, z: 1 });
    assert.equal(render.content[1].type, 'image'); assert.equal(decodePng(Buffer.from(render.content[1].data, 'base64')).width, 24);
    const type = await s.call('type_info', { type: '/obj/box/high' });
    assert.equal(type.json.data.chain[1], '/obj/box');
    const bad = await s.call('map_cell', { map: 'maps/render.dmm', x: 0, y: 1, z: 1 });
    assert.equal(bad.isError, true); assert.match(bad.json.message, /x must be an integer >= 1/);
    const escape = await s.call('map_summary', { map: '../../etc/passwd' });
    assert.equal(escape.isError, true);
    const extra = await s.call('map_summary', { map: 'maps/render.dmm', apply: true });
    assert.match(extra.json.message, /unknown argument apply/);
  } finally { await s.close(); }
});

test('edits are dry runs unless the server allows writes; prefab and diff round-trip', async () => {
  for (const allow of [false, true]) {
    const s = await startServer(allow ? ['--allow-write'] : []);
    try {
      const file = path.join(s.dir, 'maps', 'render.dmm'), before = await readFile(file);
      const prefab = (await s.call('prefab_extract', { map: 'maps/render.dmm', x1: 3, y1: 3, x2: 3, y2: 3, z: 1, layers: ['movable'] })).json.data;
      assert.deepEqual(prefab.cells, [{ dx: 0, dy: 0, atoms: ['/obj/tree'] }]);
      const patch = (await s.call('prefab_place', { map: 'maps/render.dmm', prefab, x: 2, y: 3, z: 1, mode: 'overlay' })).json.data;
      assert.equal(patch.base, createHash('sha256').update(before).digest('hex'));
      const diff = await s.call('map_diff', { map: 'maps/render.dmm', patch, render: true });
      assert.equal(diff.json.data.changedCells, 1); assert.equal(diff.content[1].type, 'image');
      const contract = { kind: 'byond-devtools-contract', schemaVersion: 1, rules: [{ id: 'one-tree', type: 'require', region: { x1: 1, y1: 1, x2: 3, y2: 3, z: 1 }, match: { paths: ['/obj/tree'] }, max: 1 }] };
      const blocked = await s.call('map_edit', { map: 'maps/render.dmm', patch, apply: true, contract });
      assert.equal(blocked.isError, true);
      assert.match(blocked.json.message, allow ? /Postcondition failed/ : /Writing is disabled/);
      const dry = await s.call('map_edit', { map: 'maps/render.dmm', patch });
      assert.equal(dry.json.data.applied, false);
      const applied = await s.call('map_edit', { map: 'maps/render.dmm', patch, apply: true });
      assert.equal(applied.isError, !allow);
      if (allow) assert.notDeepEqual(await readFile(file), before); else assert.deepEqual(await readFile(file), before);
      const check = await s.call('map_check', { map: 'maps/render.dmm', contract });
      assert.equal(check.json.data.failed, allow ? 1 : 0);
    } finally { await s.close(); }
  }
});

test('render options, icon renders and image compare', async () => {
  const s = await startServer();
  try {
    const big = await s.call('map_render', { map: 'maps/render.dmm', x1: 1, y1: 1, x2: 3, y2: 3, z: 1, scale: 2, background: '#000000', boxes: [{ x: 2, y: 2 }], file: true });
    assert.equal(big.isError, false, JSON.stringify(big.json));
    const png = decodePng(Buffer.from(big.content[1].data, 'base64'));
    assert.equal(png.width, 48); assert.equal(png.rgba[((16 * 48) + 16) * 4], 255, 'box outline at tile (2,2)');
    assert.ok(path.isAbsolute(big.json.data.image.file));
    const noInline = await s.call('map_render', { map: 'maps/render.dmm', x1: 1, y1: 1, x2: 3, y2: 3, z: 1, inline: false });
    assert.equal(noInline.content.length, 1);
    const turfsOnly = await s.call('map_render', { map: 'maps/render.dmm', x1: 1, y1: 1, x2: 3, y2: 3, z: 1, kinds: ['turf'] });
    assert.ok(turfsOnly.json.data.diagnostics.some(d => d.code === 'filtered-out' && d.detail === '/obj/tree'));
    assert.match((await s.call('map_render', { map: 'maps/render.dmm', x1: 1, y1: 1, x2: 3, y2: 3, z: 1, kinds: ['tree'] })).json.message, /kinds items must be one of/);

    const info = await s.call('icon_info', { dmi: 'icons/objs.dmi' });
    assert.deepEqual(info.json.data.states.map(x => [x.name, x.dirs]), [['box', 4], ['half', 1]]);
    const sheet = await s.call('icon_render', { dmi: 'icons/objs.dmi', state: 'box', sheet: true });
    assert.deepEqual(sheet.json.data.rows, ['south', 'north', 'east', 'west']);
    assert.equal(decodePng(Buffer.from(sheet.content[1].data, 'base64')).height, 4 * 8 + 3);
    const byType = await s.call('icon_render', { type: '/obj/tree', scale: 3 });
    assert.equal(byType.json.data.image.width, 48); assert.equal(byType.json.provenance.type, '/obj/tree');
    assert.match((await s.call('icon_render', { dmi: 'icons/objs.dmi', state: 'nope' })).json.message, /No state "nope"/);

    const same = await s.call('image_compare', { reference: big.json.data.image.file, candidate: big.json.data.image.file, show: 'none' });
    assert.equal(same.json.data.identical, true); assert.equal(same.content.length, 1);
    const ref = await s.call('map_render', { map: 'maps/render.dmm', x1: 1, y1: 1, x2: 3, y2: 3, z: 1, file: true, inline: false });
    const vsRender = await s.call('image_compare', { reference: ref.json.data.image.file, map: 'maps/render.dmm', x1: 1, y1: 1, x2: 3, y2: 3, z: 1, exclude_types: ['/obj/tree'] });
    assert.equal(vsRender.isError, false, JSON.stringify(vsRender.json));
    assert.ok(vsRender.json.data.differentPixels > 0); assert.deepEqual(vsRender.json.data.image.panels, ['reference', 'candidate', 'heatmap']);
    assert.match((await s.call('image_compare', { reference: '/etc/hostname', candidate: '/etc/hostname' })).json.message, /files this server wrote/);
  } finally { await s.close(); }
});

test('animated icon and map renders are APNGs', async () => {
  const s = await startServer();
  try {
    await writeFile(path.join(s.dir, 'icons', 'anim.dmi'), animatedDmi({ frames: 3, rewind: true, loop: 2 }));
    const icon = await s.call('icon_render', { dmi: 'icons/anim.dmi', state: 'spin', animate: true, scale: 2 });
    assert.equal(icon.isError, false, JSON.stringify(icon.json));
    const info = apngInfo(Buffer.from(icon.content[1].data, 'base64'));
    assert.deepEqual(info, { frames: 4, plays: 2, delaysMs: [100, 300, 200, 300], fdat: 3 });
    assert.deepEqual(icon.json.data.sequence.map(f => f.frame), [1, 2, 3, 2]);
    assert.equal(icon.json.data.image.width, 16); assert.equal(icon.json.data.image.animation.format, 'apng');
    assert.match((await s.call('icon_render', { dmi: 'icons/anim.dmi', state: 'spin', animate: true, sheet: true })).json.message, /animate or sheet/);
    const map = await s.call('map_render', { map: 'maps/render.dmm', x1: 1, y1: 1, x2: 3, y2: 3, z: 1, animate: { frames: 3, interval_ms: 250 } });
    assert.equal(map.isError, false, JSON.stringify(map.json));
    assert.deepEqual(apngInfo(Buffer.from(map.content[1].data, 'base64')), { frames: 3, plays: 0, delaysMs: [250, 250, 250], fdat: 2 });
    assert.match((await s.call('map_render', { map: 'maps/render.dmm', x1: 1, y1: 1, x2: 3, y2: 3, z: 1, animate: { frames: 61 } })).json.message, /2 to 60/);
    assert.match((await s.call('map_render', { map: 'maps/render.dmm', x1: 1, y1: 1, x2: 3, y2: 3, z: 1, animate: { frames: 2, speed: 1 } })).json.message, /not speed/);
  } finally { await s.close(); }
});

test('in-game renders are refused unless the server allows game runs', async () => {
  const s = await startServer();
  try { assert.match((await s.call('ingame_render', { x1: 1, y1: 1, x2: 2, y2: 2, z: 1 })).json.message, /--allow-game/); }
  finally { await s.close(); }
});

test('tools that need the type tree say so when the server has none', async () => {
  const api = createAgentApi({ root: 'fixtures/render/project' });
  await assert.rejects(api.call('map_render', { map: 'maps/render.dmm', x1: 1, y1: 1, x2: 2, y2: 2, z: 1 }), /needs the native type tree/);
  assert.equal((await api.call('map_summary', { map: 'maps/render.dmm' })).data.cellCount, 9);
});

const bin = process.env.BYOND_BIN;
test('live: ingame_render boots the fixture and returns a scaled, boxed PNG (set BYOND_BIN to run)', { skip: bin ? false : 'BYOND_BIN not set' }, async () => {
  const api = createAgentApi({ root: 'fixtures/render/project', dme: 'ingame.dme', byond: bin, allowGame: true });
  const r = await api.call('ingame_render', { x1: 1, y1: 1, x2: 3, y2: 2, z: 1, scale: 2, boxes: [{ x: 1, y: 1 }] });
  assert.equal(r.data.image.width, 48); assert.equal(decodePng(r.png).height, 32);
  assert.equal(r.provenance.truthLayer, 'native-initialized-world');
});

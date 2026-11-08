import test from 'node:test'; import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os'; import path from 'node:path';
import { createInterface } from 'node:readline';
import { decodePng } from '../src/png.js';
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

test('tools that need the type tree say so when the server has none', async () => {
  const api = createAgentApi({ root: 'fixtures/render/project' });
  await assert.rejects(api.call('map_render', { map: 'maps/render.dmm', x1: 1, y1: 1, x2: 2, y2: 2, z: 1 }), /needs the native type tree/);
  assert.equal((await api.call('map_summary', { map: 'maps/render.dmm' })).data.cellCount, 9);
});

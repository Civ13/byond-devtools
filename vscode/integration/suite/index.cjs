// Integration suite, run inside VS Code by test/run.mjs. Uses only node:assert.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const vscode = require('vscode');

const repo = path.join(__dirname, '..', '..', '..');
const project = path.join(repo, 'fixtures', 'render', 'project');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const wait = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };

async function run() {
  const results = [];
  const test = async (name, fn) => { try { await fn(); results.push(`ok - ${name}`); } catch (e) { results.push(`not ok - ${name}: ${e.stack || e}`); } };
  const ext = vscode.extensions.getExtension('civ13.byond-devtools-vscode');
  assert.ok(ext, 'extension present');
  const api = await ext.activate();
  const mapFile = path.join(project, 'maps', 'render.dmm'), before = sha(mapFile);
  const config = vscode.workspace.getConfiguration('byondDevtools');

  await test('without a type tree the preview opens and explains what is missing', async () => {
    await config.update('typeTree', '', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(mapFile), api.viewType);
    const s = await wait(() => api.sessions().find(x => x.uri === vscode.Uri.file(mapFile).toString()));
    assert.deepEqual(s.summary.world, { maxX: 3, maxY: 3, maxZ: 1 });
    const r = await s.render({ x1: 1, y1: 1, x2: 3, y2: 3, z: 1 });
    assert.match(r.error, /byondDevtools\.byondBin|typeTree/);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
  await test('with a saved type tree it renders exactly the static golden image and inspects cells', async () => {
    await config.update('typeTree', path.join(repo, 'fixtures', 'render', 'tree.xml'), vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('byondDevtools.openPreview', vscode.Uri.file(mapFile));
    const s = await wait(() => api.sessions().find(x => x.uri === vscode.Uri.file(mapFile).toString()));
    const cell = s.inspect(1, 2, 1);
    assert.deepEqual(cell.atoms.map(a => a.path), ['/obj/box/high', '/obj/box', '/turf/floor/grass', '/area/zone']);
    const r = await s.render({ x1: 1, y1: 1, x2: 3, y2: 3, z: 1 });
    assert.equal(r.error, undefined);
    const { decodePng } = await import(pathToFileURL(path.join(repo, 'src', 'png.js')).href);
    const got = decodePng(Buffer.from(r.png, 'base64')), want = decodePng(fs.readFileSync(path.join(repo, 'fixtures', 'render', 'golden.png')));
    assert.equal(got.width, 24); assert.deepEqual(Buffer.from(got.rgba), Buffer.from(want.rgba));
    assert.equal(r.diagnostics.length, 4);
    await assert.rejects(s.render({ x1: 1, y1: 1, x2: 100, y2: 100, z: 2 }), /outside the map/);
  });
  await test('the preview is read-only: the map is never modified and nothing is dirty', async () => {
    assert.equal(sha(mapFile), before);
    assert.equal(vscode.workspace.textDocuments.filter(d => d.isDirty).length, 0);
  });
  await config.update('typeTree', undefined, vscode.ConfigurationTarget.Global);
  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('not ok'));
  if (failed.length) throw new Error(`${failed.length} VS Code test(s) failed\n${failed.join('\n')}`);
}
module.exports = { run };

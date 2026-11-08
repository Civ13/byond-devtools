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
const wait = async (fn, ms = 20000, what = String(fn)) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

async function run() {
  const results = [];
  const test = async (name, fn) => { try { await fn(); results.push(`ok - ${name}`); } catch (e) { results.push(`not ok - ${name}: ${e.stack || e}`); } };
  const ext = vscode.extensions.getExtension('civ13.byond-devtools-vscode');
  assert.ok(ext, 'extension present');
  const api = await ext.activate();
  const mapFile = path.join(project, 'maps', 'render.dmm'), before = sha(mapFile);
  const config = vscode.workspace.getConfiguration('byondDevtools');
  // The fixture folder holds two .dme files (render.dme, ingame.dme), so name the one to use.
  await config.update('dme', 'render.dme', vscode.ConfigurationTarget.Global);

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
    // The webview renders on open (default view clipped to the 3x3 map) and must actually show it.
    // A cold Windows runner can take a while to start the webview, so wait longer here and, on a
    // timeout, report how far each open view got.
    const mine = () => api.sessions().filter(x => x.uri === vscode.Uri.file(mapFile).toString());
    const shown = await wait(() => mine().find(x => x.displayed)?.displayed, 60000, { toString: () => `the webview to display the image; views: ${JSON.stringify(mine().map(x => x.status))}` });
    assert.deepEqual(shown, { width: 24, height: 24, error: undefined });
    await assert.rejects(s.render({ x1: 1, y1: 1, x2: 100, y2: 100, z: 2 }), /outside the map/);
    // Show in text: the .dmm opens beside the editor with the cursor on the tile's key definition.
    await s.reveal(cell.key);
    const editor = await wait(() => vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === mapFile));
    assert.match(editor.document.lineAt(editor.selection.active.line).text, new RegExp(`^"${cell.key}" = \\(`));
    await assert.rejects(s.reveal('zz'), /not defined/);
  });
  await test('opening and rendering never modifies the map or makes it dirty', async () => {
    assert.equal(sha(mapFile), before);
    assert.equal(vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.isDirty).length, 0);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
  await test('edits are undoable, dirty the editor, and Save writes them through safe edit', async () => {
    const copy = path.join(project, 'maps', 'edit-test.dmm');
    fs.copyFileSync(mapFile, copy);
    const uri = vscode.Uri.file(copy), tabDirty = () => vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.isDirty);
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, api.viewType);
      const s = await wait(() => api.sessions().find(x => x.uri === uri.toString()));
      // sessions() returns snapshots, so look the panel up again to see it displayed.
      await wait(() => api.sessions().find(x => x.uri === uri.toString() && x.displayed));
      await assert.rejects(s.edit({ op: 'place', cells: [{ x: 1, y: 1, z: 1 }], atom: '/obj/not_a_type' }), /Not a type in this project/);
      assert.equal(await s.edit({ op: 'place', cells: [{ x: 2, y: 2, z: 1 }, { x: 3, y: 2, z: 1 }], atom: '/obj/tree' }), true);
      assert.deepEqual(s.inspect(2, 2, 1).atoms.map(a => a.path), ['/obj/tinted', '/mob/man', '/obj/tree', '/turf/floor', '/area/zone']);
      await wait(() => tabDirty());
      await vscode.commands.executeCommand('undo');
      await wait(() => s.inspect(2, 2, 1).atoms.length === 4);
      await vscode.commands.executeCommand('redo');
      await wait(() => s.inspect(2, 2, 1).atoms.length === 5);
      assert.equal(await s.edit({ op: 'set', x: 1, y: 1, z: 1, atoms: ['/obj/box{dir = 8}', '/turf/floor/grass', '/area/zone'] }), true);
      assert.equal(await s.edit({ op: 'move', from: { x: 1, y: 1, z: 1 }, index: 0, to: { x: 2, y: 1, z: 1 } }), true);
      assert.equal(sha(copy), sha(mapFile), 'nothing is written before Save');
      await vscode.commands.executeCommand('workbench.action.files.save');
      await wait(() => !tabDirty());
      const { parseDmm } = await import(pathToFileURL(path.join(repo, 'src', 'dmm.js')).href);
      const saved = parseDmm(fs.readFileSync(copy, 'utf8')), stackOf = (x, y) => saved.inspectCell(x, y, 1).atoms.map(a => a.raw.trim());
      assert.deepEqual(stackOf(2, 2), ['/obj/tinted', '/mob/man', '/obj/tree', '/turf/floor', '/area/zone']);
      assert.deepEqual(stackOf(1, 1), ['/turf/floor/grass', '/area/zone']);
      assert.deepEqual(stackOf(2, 1), ['/obj/box{dir = 8}', '/turf/floor/grass', '/area/zone']);
      assert.deepEqual(stackOf(1, 3), parseDmm(fs.readFileSync(mapFile, 'utf8')).inspectCell(1, 3, 1).atoms.map(a => a.raw.trim()));
      assert.equal(s.dirty(), false);
      // A clean editor reloads when the file changes on disk.
      fs.copyFileSync(mapFile, copy);
      await wait(() => s.inspect(2, 2, 1).atoms.length === 4);
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(copy, { force: true });
    }
    assert.equal(sha(mapFile), before, 'the fixture map itself is untouched');
  });
  await test('Compare icon with git revision opens a report for a .dmi', async () => {
    const icon = vscode.Uri.file(path.join(project, 'icons', 'objs.dmi'));
    const r = await api.compareIcon(icon, 'HEAD');
    assert.equal(r.panel, true, JSON.stringify(r));
    assert.equal(r.before.source, 'git'); assert.equal(r.summary.changed + r.summary.added + r.summary.removed, 0);
    assert.ok(r.summary.same > 0);
    assert.match((await api.compareIcon(vscode.Uri.file(mapFile), 'HEAD')).error, /not a \.dmi/);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
  await test('Resize map grows an open clean editor, refuses unsaved edits, and keeps every tile', async () => {
    const copy = path.join(project, 'maps', 'resize-test.dmm');
    fs.copyFileSync(mapFile, copy);
    const uri = vscode.Uri.file(copy);
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, api.viewType);
      const s = await wait(() => api.sessions().find(x => x.uri === uri.toString()));
      const fill = ['/turf/floor', '/area/zone'];
      assert.equal(await s.edit({ op: 'erase', cells: [{ x: 2, y: 2, z: 1 }] }), true);
      assert.match((await api.resize(uri, { maxX: 4, maxY: 3, maxZ: 1, fill, confirm: true })).error, /unsaved edits/);
      await vscode.commands.executeCommand('undo');
      await wait(() => !s.dirty());
      const cancelled = await api.resize(uri, { maxX: 4, maxY: 3, maxZ: 1, fill, confirm: false });
      assert.equal(cancelled.cancelled, true); assert.equal(sha(copy), sha(mapFile));
      const r = await api.resize(uri, { maxX: 4, maxY: 3, maxZ: 1, fill, confirm: true });
      assert.equal(r.applied, true, JSON.stringify(r));
      assert.deepEqual([r.report.keptCells, r.report.filledCells], [9, 3]);
      await wait(() => s.summary.world?.maxX === 4 || api.sessions().find(x => x.uri === uri.toString())?.summary.world?.maxX === 4, 20000, 'the editor to show the new size');
      assert.deepEqual(s.inspect(4, 1, 1).atoms.map(a => a.path), fill);
      assert.equal(s.dirty(), false);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(copy, { force: true });
    }
    assert.equal(sha(mapFile), before, 'the fixture map itself is untouched');
  });
  await test('compile explains missing setup and leaves the Problems panel empty', async () => {
    await config.update('byondBin', '', vscode.ConfigurationTarget.Global);
    const r = await vscode.commands.executeCommand('byondDevtools.compile');
    assert.match(r.error, /byondDevtools\.byondBin/);
    assert.deepEqual(api.diagnostics(), []);
    const p = await vscode.commands.executeCommand('byondDevtools.playtest', { confirmed: true, minutes: 1 });
    assert.match(p.error, /byondDevtools\.byondBin/);
  });
  await config.update('byondBin', undefined, vscode.ConfigurationTarget.Global);
  await config.update('typeTree', undefined, vscode.ConfigurationTarget.Global);
  await config.update('dme', undefined, vscode.ConfigurationTarget.Global);
  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('not ok'));
  if (failed.length) throw new Error(`${failed.length} VS Code test(s) failed\n${failed.join('\n')}`);
}
module.exports = { run };

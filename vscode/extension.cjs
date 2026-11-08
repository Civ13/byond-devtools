// BYOND Map Editor: a custom editor for .dmm files (rendered view, tile editing with undo,
// saving through the safe-edit core), plus compile and local playtest commands. The text
// editor stays the default for .dmm. Compile runs DreamMaker in a temp folder; playtest asks
// first, then runs the game locally.
const vscode = require('vscode');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');

const VIEW_TYPE = 'byondDevtools.mapPreview';
let sessionModule, devrunModule, mapdocModule, diagnostics, output;
const sessions = new Set();
const devrunLib = async () => devrunModule ??= await import(pathToFileURL(path.join(__dirname, 'lib', 'devrun.mjs')).href);
const mapdocLib = async () => mapdocModule ??= await import(pathToFileURL(path.join(__dirname, 'lib', 'mapdoc.mjs')).href);
const sessionLib = async () => sessionModule ??= await import(pathToFileURL(path.join(__dirname, 'lib', 'session.mjs')).href);

/** The .dme to use: the setting, else the only .dme at the workspace folder root. */
async function findDme(folder) {
  const setting = vscode.workspace.getConfiguration('byondDevtools', folder.uri).get('dme');
  if (setting) return setting;
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '*.dme'), null, 2);
  return found.length === 1 ? path.relative(folder.uri.fsPath, found[0].fsPath).split(path.sep).join('/') : null;
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
/** A map file's text (BOM stripped, strict UTF-8) and the sha256 of its bytes. */
async function readMap(uri) {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes), sha: sha256(bytes) };
}
const MAX_CELLS_PER_EDIT = 64 * 64;

/**
 * The map editor. A document holds the map text in memory; every change is a whole-stack
 * edit planned by the safe-edit core (src/edit.js), and Save writes one patch from the saved
 * file to the current stacks with editMapFile (src/edit-project.js): base sha256, expected
 * stacks, re-parse verification and an atomic replace. A file changed on disk since it was
 * opened or saved makes Save fail instead of overwriting it.
 */
class MapEditorProvider {
  constructor(context) {
    this.context = context;
    this.changes = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this.changes.event;
  }
  async openCustomDocument(uri, openContext) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const root = folder ? folder.uri.fsPath : path.dirname(uri.fsPath);
    const config = vscode.workspace.getConfiguration('byondDevtools', uri);
    const resolve = p => p && !path.isAbsolute(p) ? path.join(root, p) : p;
    const { openSession, coreDir } = await sessionLib(), { openMapModel } = await mapdocLib();
    const core = coreDir(path.join(__dirname, 'lib'));
    const doc = { uri, root, core, panels: new Set(), model: null, session: null, error: null, savedSha: null, diskChanged: false, dispose() { this.watcher?.dispose(); } };
    try {
      const file = await readMap(uri);
      doc.model = await openMapModel({ text: file.text, core }); doc.savedSha = file.sha;
      if (openContext.backupId) doc.model.restore(file.text, (await readMap(vscode.Uri.parse(openContext.backupId))).text);
      doc.session = await openSession({ text: () => doc.model.text, root, mapRelative: path.relative(root, uri.fsPath),
        dme: folder ? await findDme(folder) : null, treeFile: resolve(config.get('typeTree')), byondBin: config.get('byondBin') || undefined, core });
    } catch (e) { doc.error = e.message; return doc; }
    // Reload a clean document when the file changes on disk (git pull, mapmerge2); keep a dirty one and say so.
    // Watch through the workspace folder (the recursive watcher): a watch on the file itself
    // can stop on Linux once a save replaces the file by rename.
    const pattern = folder ? new vscode.RelativePattern(folder, path.relative(root, uri.fsPath).split(path.sep).join('/'))
      : new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath));
    doc.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onDisk = async () => {
      try {
        if (doc.saving) return; // our own save; it updates savedSha itself
        const file = await readMap(uri); if (doc.saving || file.sha === doc.savedSha) return;
        if (doc.model.isDirty()) { doc.diskChanged = true; this.refresh(doc, 'The file changed on disk. Save will refuse; use "File: Revert File" to load it.'); return; }
        doc.model.reset(file.text); doc.savedSha = file.sha; this.refresh(doc, 'Reloaded: the file changed on disk.');
      } catch (e) { this.refresh(doc, `Could not reload: ${e.message}`); }
    };
    doc.watcher.onDidChange(onDisk); doc.watcher.onDidCreate(onDisk);
    return doc;
  }
  refresh(doc, message) { for (const p of doc.panels) p.webview.postMessage({ type: 'changed', summary: doc.session.summary(), message }); }
  /** Apply a model change as one undoable VS Code edit. Returns true when something changed. */
  record(doc, label, change) {
    if (!change) return false;
    this.changes.fire({ document: doc, label,
      undo: () => { doc.model.setCells(change.before); this.refresh(doc); },
      redo: () => { doc.model.setCells(change.after); this.refresh(doc); } });
    this.refresh(doc);
    return true;
  }
  /** One editing request from the webview (or the test hook). */
  async edit(doc, m) {
    const cells = m.cells ?? [];
    if (cells.length > MAX_CELLS_PER_EDIT) throw new Error(`One edit is limited to ${MAX_CELLS_PER_EDIT} tiles`);
    // A path the project does not define would compile into a map error; catch it here when the tree is loaded.
    const atoms = m.op === 'place' ? [m.atom] : m.op === 'stamp' || m.op === 'set' ? m.atoms : [];
    const known = m.op === 'set' ? new Set(doc.model.stackAt(m.x, m.y, m.z).map(a => a.replace(/\{[\s\S]*$/, '').trim())) : new Set();
    const unknown = await doc.session.unknownTypes(atoms.map(a => String(a).replace(/\{[\s\S]*$/, '').trim()).filter(p => !known.has(p)));
    if (unknown.length) throw new Error(`Not a type in this project: ${unknown.join(', ')}`);
    const model = doc.model;
    switch (m.op) {
      case 'set': return this.record(doc, 'Edit tile', model.setCells([{ x: m.x, y: m.y, z: m.z, set: m.atoms }]));
      case 'place': return this.record(doc, `Place ${m.atom}`, model.place(cells, m.atom));
      case 'erase': return this.record(doc, 'Erase', model.erase(cells));
      case 'stamp': return this.record(doc, 'Stamp', model.stamp(cells, m.atoms));
      case 'move': return this.record(doc, 'Move object', model.move(m.from, m.index, m.to));
      default: throw new Error(`Unknown edit ${m.op}`);
    }
  }
  async saveCustomDocument(doc) {
    const patch = doc.model.savePatch();
    if (!patch.edits.length) return;
    const { editMapFile } = await import(pathToFileURL(path.join(doc.core, 'edit-project.js')).href);
    doc.saving = true;
    try {
      await editMapFile({ root: doc.root, map: path.relative(doc.root, doc.uri.fsPath), patch: { base: doc.savedSha, ...patch }, apply: true, maxEdits: doc.model.map.cellCount });
      const file = await readMap(doc.uri);
      doc.model.reset(file.text); doc.savedSha = file.sha; doc.diskChanged = false;
    } catch (e) { throw new Error(`BYOND map not saved: ${e.message}`); }
    finally { doc.saving = false; }
    this.refresh(doc, `Saved ${patch.edits.length} tile(s) through safe edit.`);
  }
  async saveCustomDocumentAs() {
    throw new Error('Save As is not available for BYOND maps: a map is only written as a verified edit of the file it was opened from. Save, then copy the file.');
  }
  async revertCustomDocument(doc) {
    const file = await readMap(doc.uri);
    doc.model.reset(file.text); doc.savedSha = file.sha; doc.diskChanged = false;
    this.refresh(doc, 'Reverted to the file on disk.');
  }
  // A hot-exit backup of the unsaved text; restoring it never writes the map itself.
  async backupCustomDocument(doc, { destination }) {
    await vscode.workspace.fs.writeFile(destination, Buffer.from(doc.model.text, 'utf8'));
    return { id: destination.toString(), delete: () => vscode.workspace.fs.delete(destination).then(undefined, () => {}) };
  }
  async resolveCustomEditor(doc, panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = html(panel.webview, media);
    const post = message => panel.webview.postMessage(message);
    if (doc.error) { panel.webview.onDidReceiveMessage(m => { if (m.type === 'ready') post({ type: 'error', message: doc.error }); }); return; }
    const record = { uri: doc.uri.toString(), doc, provider: this, panel, displayed: null };
    sessions.add(record); doc.panels.add(panel);
    panel.onDidDispose(() => { sessions.delete(record); doc.panels.delete(panel); });
    const session = doc.session;
    panel.webview.onDidReceiveMessage(async m => {
      try {
        if (m.type === 'ready') { post({ type: 'summary', summary: session.summary() }); post({ type: 'types', paths: await session.typePaths() }); }
        else if (m.type === 'inspect') post({ type: 'cell', cell: session.inspect(m.x, m.y, m.z) });
        else if (m.type === 'vars') post({ type: 'vars', path: m.path, vars: await session.varsOf(m.path) });
        else if (m.type === 'displayed') record.displayed = { width: m.width, height: m.height, error: m.error };
        else if (m.type === 'render') post({ type: 'image', ...await session.render(m.view) });
        else if (m.type === 'edit') { if (!await this.edit(doc, m)) post({ type: 'error', message: 'Nothing changed.' }); }
        else if (m.type === 'undo' || m.type === 'redo') await vscode.commands.executeCommand(m.type);
      } catch (e) { post({ type: 'error', message: e.message }); }
    });
  }
}

function html(webview, media) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css'));
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"></head><body>
<header><span id="title">BYOND map editor</span>
<label>z <select id="z"></select></label>
<label>x <input id="x" type="number" min="1" value="1"></label><label>y <input id="y" type="number" min="1" value="1"></label>
<label>size <select id="size"><option>16</option><option selected>32</option><option>64</option></select></label>
<button id="go">Render</button>
<span class="tools"><button data-tool="select" title="Click a tile to inspect and edit its stack">Select</button><button data-tool="place" title="Click or drag to place the brush type">Place</button><button data-tool="erase" title="Click or drag to remove the top object">Erase</button><button data-tool="stamp" title="Click or drag to copy a whole stack">Stamp</button></span>
<button id="undo" class="secondary" title="Undo (Ctrl+Z)">Undo</button><button id="redo" class="secondary" title="Redo (Ctrl+Y)">Redo</button>
<span id="brushbar"><input id="brush" list="types" placeholder="type path to place, e.g. /obj/structure/chair" spellcheck="false"></span><span id="stampinfo" hidden>Stamp: none</span>
<span id="status"></span></header>
<main><div id="view"><div class="stage"><img id="image" alt=""><canvas id="overlay"></canvas></div></div><aside><h3>Cell</h3><div id="cell">Click a tile.</div><h3>Report</h3><pre id="report"></pre></aside></main>
<datalist id="types"></datalist>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}

/** Workspace folder, .dme and settings for compile/playtest. */
async function projectSetup() {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
  if (!folder) return { error: 'Open a folder with a BYOND project first.' };
  const config = vscode.workspace.getConfiguration('byondDevtools', folder.uri);
  const { coreDir } = await sessionLib();
  return { folder, root: folder.uri.fsPath, dme: await findDme(folder), byondBin: config.get('byondBin') || undefined, core: coreDir(path.join(__dirname, 'lib')) };
}

/** Replace the BYOND problems with a compile/playtest report. */
async function publish(root, report) {
  const { toDiagnostics } = await devrunLib();
  diagnostics.clear();
  const severity = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning };
  for (const [file, list] of toDiagnostics(report)) {
    diagnostics.set(vscode.Uri.file(path.join(root, file)), list.map(d => {
      const line = Math.max(0, (d.line ?? 1) - 1), diag = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1000), d.message, severity[d.severity]);
      diag.source = d.source; if (d.code) diag.code = d.code; return diag;
    }));
  }
}

async function compileCommand() {
  const setup = await projectSetup();
  if (setup.error) { vscode.window.showWarningMessage(setup.error); return { error: setup.error }; }
  const { compile } = await devrunLib();
  const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `BYOND: compiling ${setup.dme ?? ''}` }, () => compile(setup));
  if (report.error) { vscode.window.showWarningMessage(report.error); return report; }
  await publish(setup.root, { compile: report });
  const text = `BYOND compile ${report.status === 'ok' ? 'succeeded' : 'failed'}: ${report.errors} error(s), ${report.warnings} warning(s) in ${report.seconds.toFixed(1)} s`;
  (report.status === 'ok' ? vscode.window.showInformationMessage : vscode.window.showErrorMessage)(text);
  return report;
}

async function playtestCommand(options = {}) {
  const setup = await projectSetup();
  if (setup.error) { vscode.window.showWarningMessage(setup.error); return { error: setup.error }; }
  if (!options.confirmed) {
    const go = await vscode.window.showWarningMessage('Start a local playtest? This compiles and RUNS the game on this computer (temporary folder, -safe, 127.0.0.1 only, no saves).', { modal: true }, 'Start playtest');
    if (go !== 'Start playtest') return { cancelled: true };
  }
  const { startPlaytest } = await devrunLib();
  output.show(true);
  output.appendLine(`--- playtest of ${setup.dme} (${new Date().toISOString()}) ---`);
  const minutes = options.minutes ?? vscode.workspace.getConfiguration('byondDevtools', setup.folder.uri).get('playtestMinutes') ?? 30;
  const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'BYOND playtest', cancellable: true }, (progress, token) => {
    const ac = new AbortController(); token.onCancellationRequested(() => ac.abort());
    progress.report({ message: 'compiling...' });
    return startPlaytest({ ...setup, minutes, profileProcs: !!options.profileProcs, signal: ac.signal, onLog: chunk => output.append(chunk),
      onReady: ({ url }) => {
        progress.report({ message: `running at ${url} - Cancel stops the world` });
        output.appendLine(`Join with Dream Seeker: ${url}`);
        if (!options.confirmed) vscode.window.showInformationMessage(`Playtest running at ${url}`, 'Open in Dream Seeker').then(c => { if (c) vscode.env.openExternal(vscode.Uri.parse(url)); });
      } });
  });
  if (report.error) { vscode.window.showWarningMessage(report.error); return report; }
  await publish(setup.root, report);
  const errors = report.runtime?.total ?? 0;
  output.appendLine(`--- playtest ${report.status}: ${errors} runtime error(s), ${report.runtime?.unique.length ?? 0} distinct ---`);
  return report;
}

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection('byond');
  output = vscode.window.createOutputChannel('BYOND Playtest');
  context.subscriptions.push(diagnostics, output);
  context.subscriptions.push(vscode.commands.registerCommand('byondDevtools.compile', compileCommand));
  context.subscriptions.push(vscode.commands.registerCommand('byondDevtools.playtest', playtestCommand));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, new MapEditorProvider(context), { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }));
  context.subscriptions.push(vscode.commands.registerCommand('byondDevtools.openPreview', async uri => {
    uri = uri || vscode.window.activeTextEditor?.document.uri;
    if (!uri || !uri.fsPath.endsWith('.dmm')) { vscode.window.showWarningMessage('Open a .dmm map first.'); return; }
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  }));
  // Test hook: lets the integration tests drive and inspect open previews.
  return {
    viewType: VIEW_TYPE,
    diagnostics: () => { const out = []; diagnostics.forEach((uri, list) => out.push({ uri: uri.toString(), list: list.map(d => ({ line: d.range.start.line + 1, message: d.message, severity: d.severity })) })); return out; },
    sessions: () => [...sessions].map(s => ({ uri: s.uri, summary: s.doc.session.summary(), displayed: s.displayed, inspect: (x, y, z) => s.doc.session.inspect(x, y, z), render: v => s.doc.session.render(v),
      edit: m => s.provider.edit(s.doc, m), text: () => s.doc.model.text, dirty: () => s.doc.model.isDirty() })),
  };
}
function deactivate() {}
module.exports = { activate, deactivate };

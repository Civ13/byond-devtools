// BYOND Map Preview: a read-only custom editor for .dmm files.
// It never edits or saves the map; the text editor stays the default for .dmm.
const vscode = require('vscode');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');

const VIEW_TYPE = 'byondDevtools.mapPreview';
let sessionModule;
const sessions = new Set();
const sessionLib = async () => sessionModule ??= await import(pathToFileURL(path.join(__dirname, 'lib', 'session.mjs')).href);

/** The .dme to use: the setting, else the only .dme at the workspace folder root. */
async function findDme(folder) {
  const setting = vscode.workspace.getConfiguration('byondDevtools', folder.uri).get('dme');
  if (setting) return setting;
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '*.dme'), null, 2);
  return found.length === 1 ? path.relative(folder.uri.fsPath, found[0].fsPath).split(path.sep).join('/') : null;
}

class MapPreviewProvider {
  constructor(context) { this.context = context; }
  async openCustomDocument(uri) { return { uri, dispose() {} }; }
  async resolveCustomEditor(document, panel) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const root = folder ? folder.uri.fsPath : path.dirname(document.uri.fsPath);
    const config = vscode.workspace.getConfiguration('byondDevtools', document.uri);
    const resolve = p => p && !path.isAbsolute(p) ? path.join(root, p) : p;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = html(panel.webview, media);
    const post = message => panel.webview.postMessage(message);
    let session;
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      const { openSession, coreDir } = await sessionLib();
      session = await openSession({ text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), root, mapRelative: path.relative(root, document.uri.fsPath),
        dme: folder ? await findDme(folder) : null, treeFile: resolve(config.get('typeTree')), byondBin: config.get('byondBin') || undefined, core: coreDir(path.join(__dirname, 'lib')) });
    } catch (e) { post({ type: 'error', message: e.message }); return; }
    const record = { uri: document.uri.toString(), session, panel, lastRender: null, displayed: null };
    sessions.add(record);
    panel.onDidDispose(() => sessions.delete(record));
    panel.webview.onDidReceiveMessage(async m => {
      try {
        if (m.type === 'ready') post({ type: 'summary', summary: session.summary() });
        else if (m.type === 'inspect') post({ type: 'cell', cell: session.inspect(m.x, m.y, m.z) });
        else if (m.type === 'displayed') record.displayed = { width: m.width, height: m.height, error: m.error };
        else if (m.type === 'render') { const r = await session.render(m.view); record.lastRender = r; post({ type: 'image', ...r }); }
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
<header><span id="title">BYOND map preview (read-only)</span>
<label>z <select id="z"></select></label>
<label>x <input id="x" type="number" min="1" value="1"></label><label>y <input id="y" type="number" min="1" value="1"></label>
<label>size <select id="size"><option>16</option><option selected>32</option><option>64</option></select></label>
<button id="go">Render</button><span id="status"></span></header>
<main><div id="view"><img id="image" alt=""></div><aside><h3>Cell</h3><pre id="cell">Click a tile.</pre><h3>Report</h3><pre id="report"></pre></aside></main>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}

function activate(context) {
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, new MapPreviewProvider(context), { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.commands.registerCommand('byondDevtools.openPreview', async uri => {
    uri = uri || vscode.window.activeTextEditor?.document.uri;
    if (!uri || !uri.fsPath.endsWith('.dmm')) { vscode.window.showWarningMessage('Open a .dmm map first.'); return; }
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  }));
  // Test hook: lets the integration tests drive and inspect open previews.
  return {
    viewType: VIEW_TYPE,
    sessions: () => [...sessions].map(s => ({ uri: s.uri, summary: s.session.summary(), displayed: s.displayed, inspect: (x, y, z) => s.session.inspect(x, y, z), render: v => s.session.render(v) })),
  };
}
function deactivate() {}
module.exports = { activate, deactivate };

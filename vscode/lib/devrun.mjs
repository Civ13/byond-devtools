/**
 * Compile and playtest for the extension. Independent of the VS Code API so it can be tested
 * with node:test: it returns plain diagnostics that extension.cjs turns into vscode.Diagnostic.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const load = async (dir, file) => import(pathToFileURL(path.join(dir, file)).href);

/** Group compiler diagnostics and runtime errors by project-relative file. */
export function toDiagnostics({ compile, runtime } = {}) {
  const byFile = new Map();
  const add = (file, d) => { if (!file) return; const list = byFile.get(file) ?? []; list.push(d); byFile.set(file, list); };
  for (const d of compile?.diagnostics ?? []) add(d.file, { line: d.line, severity: d.severity, message: d.message, code: d.code ?? undefined, source: 'DreamMaker' });
  for (const e of runtime?.unique ?? []) add(e.file, { line: e.line, severity: 'error', message: `runtime error: ${e.message}${e.count > 1 ? ` (x${e.count})` : ''}${e.proc ? `\nproc: ${e.proc}` : ''}${e.callStack.length ? `\n${e.callStack.join('\n')}` : ''}`, source: 'DreamDaemon playtest' });
  return byFile;
}

/** Why compile/playtest cannot run, or null when they can. */
export function missingSetup({ dme, byondBin }) {
  if (!dme) return 'No .dme found or configured (byondDevtools.dme).';
  if (!byondBin) return 'Set byondDevtools.byondBin to your BYOND bin folder (the one with dm.exe / DreamMaker) to compile.';
  return null;
}

export async function compile({ root, dme, byondBin, core }) {
  const missing = missingSetup({ dme, byondBin }); if (missing) return { error: missing };
  const { compileProject } = await load(core, 'devrun-project.js');
  return compileProject({ root, dme, binDir: byondBin });
}

export async function startPlaytest({ root, dme, byondBin, core, minutes, profileProcs, signal, onReady, onLog }) {
  const missing = missingSetup({ dme, byondBin }); if (missing) return { error: missing };
  const { playtest } = await load(core, 'devrun-project.js');
  return playtest({ root, dme, binDir: byondBin, minutes, profileProcs, signal, onReady, onLog });
}

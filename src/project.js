import { realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
/** Project-relative, realpath-contained binary read with SHA-256 provenance. */
export async function readProjectBytes(root, relative, maxBytes = 64 * 1024 * 1024) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('File must be project-relative');
  const projectRoot = await realpath(root), file = await realpath(path.resolve(projectRoot, relative));
  const relation = path.relative(projectRoot, file);
  if (relation === '..' || relation.startsWith('..' + path.sep) || path.isAbsolute(relation)) throw new Error('File escapes project root');
  const info = await stat(file); if (!info.isFile() || info.size > maxBytes) throw new Error('Not a regular file or byte limit exceeded');
  const bytes = await readFile(file); if (bytes.byteLength > maxBytes) throw new Error('Byte limit exceeded');
  return { data: bytes, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), projectRoot, relative: relation };
}
/** Same as readProjectBytes, decoded as strict UTF-8. */
export async function readProjectFile(root, relative, maxBytes = 64 * 1024 * 1024) {
  const { data, ...rest } = await readProjectBytes(root, relative, maxBytes);
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), ...rest };
}
/** Lexical include inventory ONLY. Does not preprocess DM or resolve active includes. */
export function inspectDme(text) {
  const includes = []; let blockComment = false, quote = null, multiline = false;
  for (const [index, original] of text.split(/\r?\n/).entries()) {
    let line = '', escaped = false; const beganInString = quote !== null || multiline;
    for (let i = 0; i < original.length; i++) {
      const c = original[i], next = original[i+1];
      if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
      if (multiline) { if (c === '"' && next === '}' && !escaped) { multiline = false; i++; } escaped = !escaped && c === '\\'; continue; }
      if (quote !== null) {
        line += c;
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '/' && next === '/') break;
      if (c === '/' && next === '*') { blockComment = true; i++; continue; }
      if (c === '{' && next === '"') { multiline = true; line += '{"'; i++; continue; }
      line += c;
      if (c === '"' || c === "'") quote = c;
    }
    const m = !beganInString && /^\s*#include\s+"([^"\r\n]+)"\s*$/.exec(line);
    if (m) includes.push({ path: m[1], line: index + 1, activation: 'unknown-not-preprocessed' });
  }
  return { schemaVersion: 1, includes, resolution: 'lexical-only', limitations: ['Conditional includes, macros, DM inheritance and type validity are not resolved.'] };
}

/**
 * Native type tree for a project. Runs the caller's own DreamMaker with -o on a one-line
 * probe .dme in a temporary directory that #includes the project's .dme by absolute path,
 * so the compiler's resource file (.rsc) is written to the temp directory, never the project.
 * Alternatively reads a saved `DreamMaker -o` XML file. Returns the XML with project-relative
 * file attributes, plus a project-contained source-line reader and lexical #define table.
 */
const prefixOf = dir => dir.split(path.sep).join('/') + '/';
export async function loadProjectTypes({ root, dme, binDir, treeFile, timeoutMs = 600000 }) {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const dmeFile = await readProjectFile(root, dme, 16 * 1024 * 1024);
  const projectRoot = dmeFile.projectRoot;
  let xml, compiler = null;
  if (treeFile) {
    const bytes = await readFile(treeFile); if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('Type tree byte limit exceeded');
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } else {
    if (!binDir) throw new Error('--byond BIN or --tree FILE is required');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'byond-types-'));
    try {
      const absolute = path.join(projectRoot, dmeFile.relative).split(path.sep).join('/');
      const rootDir = projectRoot.split(path.sep).join('/').replace(/"/g, '');
      await writeFile(path.join(dir, 'probe.dme'), `#define FILE_DIR "${rootDir}"\n#include "${absolute.replace(/"/g, '')}"\n`);
      const exe = path.join(binDir, process.platform === 'win32' ? 'dm.exe' : 'DreamMaker');
      const env = { ...process.env, LD_LIBRARY_PATH: [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) };
      const r = spawnSync(exe, ['-o', 'probe.dme'], { cwd: dir, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024 });
      if (r.error) throw r.error;
      const at = r.stdout.indexOf('<?xml');
      xml = at >= 0 ? r.stdout.slice(at) : r.stdout;
      const messages = `${at > 0 ? r.stdout.slice(0, at) : ''}${r.stderr || ''}`;
      // DreamMaker -o prints the tree even when compilation fails, so errors must be surfaced.
      compiler = { status: r.status, errors: messages.split(/\r?\n/).filter(l => /:error:/.test(l)).map(l => l.replaceAll('\\', '/').split(prefixOf(projectRoot)).join('')).slice(0, 50),
        errorCount: (messages.match(/:error:/g) || []).length };
      if (!xml.includes('<dm>')) throw new Error(`DreamMaker -o produced no object tree (exit ${r.status}): ${messages.slice(-500)}`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  // Make file attributes project-relative so diagnostics match the checkout.
  // dm.exe on Windows prints absolute backslash paths whose drive-letter case follows the
  // #include, not realpath, so normalise slashes (and case on Windows) before stripping.
  const prefix = prefixOf(projectRoot), fold = process.platform === 'win32' ? s => s.toLowerCase() : s => s;
  xml = xml.replace(/file="([^"]*)"/g, (_, f) => {
    const p = f.replaceAll('\\', '/');
    return `file="${fold(p).startsWith(fold(prefix)) ? p.slice(prefix.length) : p}"`;
  });
  const includes = inspectDme(dmeFile.text).includes.filter(i => /\.dm$/i.test(i.path));
  const texts = [dmeFile.text];
  for (const inc of includes) {
    try { texts.push((await readProjectFile(root, path.join(path.dirname(dmeFile.relative), inc.path.replaceAll('\\', '/')))).text); } catch { /* missing or outside: not a define source */ }
  }
  const lines = new Map();
  async function preload(files) {
    for (const f of files) if (!lines.has(f)) {
      try { lines.set(f, (await readProjectFile(root, f)).text.split(/\r?\n/)); } catch { lines.set(f, null); }
    }
  }
  const sourceLine = (file, line) => lines.get(file)?.[line - 1] ?? null;
  return { xml, compiler, defineSources: texts, preload, sourceLine, dme: { file: dme, sha256: dmeFile.sha256 } };
}

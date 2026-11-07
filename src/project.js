import { realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export async function readProjectFile(root, relative, maxBytes = 64 * 1024 * 1024) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('File must be project-relative');
  const projectRoot = await realpath(root), file = await realpath(path.resolve(projectRoot, relative));
  const relation = path.relative(projectRoot, file);
  if (relation === '..' || relation.startsWith('..' + path.sep) || path.isAbsolute(relation)) throw new Error('File escapes project root');
  const info = await stat(file); if (!info.isFile() || info.size > maxBytes) throw new Error('Not a regular file or byte limit exceeded');
  const bytes = await readFile(file); if (bytes.byteLength > maxBytes) throw new Error('Byte limit exceeded');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { text, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), projectRoot, relative: relation };
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

#!/usr/bin/env node
// Parses every .dmm under a checkout's map folder and reports failures as JSON.
// Read-only: files are read through the same root-contained reader as the CLI.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { parseDmm } from '../src/dmm.js';
import { readProjectFile } from '../src/project.js';
const args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const root = value('--root'), maps = value('--maps') || 'maps', minimum = Number(value('--expect-at-least') || 1);
if (!root) { console.error('Usage: node scripts/corpus.js --root CHECKOUT [--maps maps] [--expect-at-least N]'); process.exit(2); }
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel); else if (entry.name.endsWith('.dmm')) files.push(rel);
  }
})(maps);
files.sort();
const failures = []; let cells = 0, tgm = 0, crlf = 0; const started = performance.now();
for (const file of files) {
  try {
    const input = await readProjectFile(root, file);
    if (input.text.includes('\r\n')) crlf++;
    if (/^\s*"[A-Za-z]+" = \(\n/m.test(input.text.replaceAll('\r\n', '\n'))) tgm++;
    cells += parseDmm(input.text).cellCount;
  } catch (error) { failures.push({ file: file.split(path.sep).join('/'), error: error.name, message: error.message }); }
}
const report = { schemaVersion: 1, root: path.resolve(root), maps: files.length, parsed: files.length - failures.length,
  tgmStyle: tgm, crlf, cells, milliseconds: Math.round(performance.now() - started), failures };
console.log(JSON.stringify(report, null, 2));
if (failures.length || files.length < minimum) process.exitCode = 1;

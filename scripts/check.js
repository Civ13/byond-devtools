#!/usr/bin/env node
// Syntax-checks every JavaScript module in the repository's source folders.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const roots = ['src', 'scripts', 'test'];
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); }
    else if (/\.(m?js)$/.test(entry.name)) files.push(full);
  }
}
for (const root of roots) walk(root);
let failed = 0;
for (const file of files.sort()) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) { failed++; process.stderr.write(`${file}\n${r.stderr}`); }
}
console.log(`${files.length - failed}/${files.length} files passed node --check`);
process.exitCode = failed ? 1 : 0;

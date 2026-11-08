/**
 * In-game truth layer: boot the real game headless and record the final appearance of a region.
 *
 * Unlike src/native.js this RUNS GAME CODE (New, Initialize, smoothing, lighting, round start).
 * It is only for a local checkout the caller chose, in a fresh temporary directory, with
 * DreamDaemon in -safe mode bound to 127.0.0.1, no saves and only the checkout's config/ copied
 * in. Nothing is written to the checkout: the probe .dme lives in the temp folder and includes
 * the checkout's files by absolute path. Never point it at a live server's files.
 */
import { mkdtemp, writeFile, readFile, rm, cp, stat, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { readProjectFile, readProjectBytes } from './project.js';
import { decodeDmi } from './dmi.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROFILES = Object.freeze(['default', 'civ13']);
const posix = p => p.split(path.sep).join('/');
const dmString = s => '"' + s.replace(/[\\"\[\]]/g, c => '\\' + c) + '"';

/**
 * Probe .dme text: the project's .dme with every relative #include made absolute, FILE_DIR set
 * to the checkout, an optional map swapped into the BEGIN/END_SELECTED_MAP block, then the
 * probe and the game profile appended.
 */
export async function probeSource({ root, dme, map, profile = 'default', probe = 'ingame' }) {
  if (!['ingame', 'playtest', 'none'].includes(probe)) throw new Error(`Unknown probe ${probe}`);
  if (!PROFILES.includes(profile)) throw new Error(`Unknown profile ${profile}; one of ${PROFILES.join(', ')}`);
  const file = await readProjectFile(root, dme, 16 * 1024 * 1024);
  const base = posix(path.dirname(path.join(file.projectRoot, file.relative)));
  let text = file.text.replace(/^﻿/, '');
  const abs = rel => dmString(path.posix.resolve(base, rel.replaceAll('\\', '/')));
  if (map) {
    const mapAbs = posix(path.join(file.projectRoot, (await readProjectFile(root, map, 256 * 1024 * 1024)).relative));
    const block = /\/\/ BEGIN_SELECTED_MAP[\s\S]*?\/\/ END_SELECTED_MAP/;
    const include = `// BEGIN_SELECTED_MAP\n#include ${dmString(mapAbs)}\n// END_SELECTED_MAP`;
    if (block.test(text)) text = text.replace(block, include);
    else text = text.replace(/^[ \t]*#include\s+"[^"]*\.dmm"[ \t]*$/gim, '') + `\n${include}\n`;
  }
  text = text.replace(/^([ \t]*#include\s+)"([^"]+)"/gm, (all, head, rel) => rel.startsWith('/') ? all : head + abs(rel));
  const rootDir = dmString(posix(file.projectRoot));
  text = /^#define\s+FILE_DIR\b.*$/m.test(text) ? text.replace(/^#define\s+FILE_DIR\b.*$/m, `#define FILE_DIR ${rootDir}`) : `#define FILE_DIR ${rootDir}\n${text}`;
  if (probe === 'none') return { text, dmeSha256: file.sha256, projectRoot: file.projectRoot };
  if (probe === 'playtest') return { text: `${text}\n// ---- byond-devtools playtest probe ----\n${await readFile(path.join(HERE, 'playtest-probe.dm'), 'utf8')}`, dmeSha256: file.sha256, projectRoot: file.projectRoot };
  const ingame = await readFile(path.join(HERE, 'ingame-probe.dm'), 'utf8');
  const prof = await readFile(path.join(HERE, 'ingame-profiles', `${profile}.dm`), 'utf8');
  return { text: `${text}\n// ---- byond-devtools in-game probe ----\n${ingame}\n${prof}`, dmeSha256: file.sha256, projectRoot: file.projectRoot };
}

export function run(cmd, args, { cwd, env, timeoutMs, onTick }) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', timedOut = false;
    child.stdout.on('data', d => { out += d; if (out.length > 4e6) out = out.slice(-2e6); });
    child.stderr.on('data', d => { out += d; if (out.length > 4e6) out = out.slice(-2e6); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const tick = onTick ? setInterval(onTick, 5000) : null;
    child.on('close', code => { clearTimeout(timer); if (tick) clearInterval(tick); resolve({ code, out, timedOut }); });
    child.on('error', e => { clearTimeout(timer); if (tick) clearInterval(tick); resolve({ code: -1, out: out + String(e), timedOut }); });
  });
}

/**
 * Compile and boot. Returns {status, dump?, dir?, compiler, runtime, seconds}. status is 'ok',
 * 'compile-failed', 'run-failed' or 'probe-failed'. `keepDir` keeps the run folder (with the
 * exported icons the dump refers to); otherwise the dump is returned with icon bytes inlined.
 */
export async function recordIngame({ root, dme, map, binDir, profile = 'default', region, timeOfDay, settleDs = 50,
  timeoutMs = 3600000, keepDir = false, onPhase }) {
  if (!binDir) throw new Error('binDir (BYOND bin directory) is required');
  const { x1, y1, x2, y2, z } = region;
  for (const v of [x1, y1, x2, y2, z]) if (!Number.isSafeInteger(v) || v < 1) throw new TypeError('Region coordinates must be positive integers');
  if (x2 < x1 || y2 < y1 || (x2 - x1 + 1) * (y2 - y1 + 1) > 128 * 128) throw new RangeError('Region must be non-empty and at most 128x128 tiles');
  const started = Date.now();
  const src = await probeSource({ root, dme, map, profile });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'byond-ingame-'));
  const env = { ...process.env, LD_LIBRARY_PATH: [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) };
  const exe = name => path.join(binDir, process.platform === 'win32' ? (name === 'DreamMaker' ? 'dm.exe' : 'dd.exe') : name);
  try {
    await writeFile(path.join(dir, 'probe.dme'), src.text);
    onPhase?.('compile');
    const c = await run(exe('DreamMaker'), ['-max_errors', '0', 'probe.dme'], { cwd: dir, env, timeoutMs });
    const compiler = c.out.split(/\r?\n/).filter(l => /error|warning|\d+ errors/.test(l)).slice(-40).join('\n');
    if (c.code !== 0 || !/ 0 errors/.test(c.out)) return { status: 'compile-failed', compiler, seconds: (Date.now() - started) / 1000 };
    // The game reads its config from the run folder; copy the checkout's config/ only.
    const config = path.join(path.dirname(path.resolve(root, dme)), 'config');
    if (await stat(config).then(s => s.isDirectory(), () => false)) await cp(config, path.join(dir, 'config'), { recursive: true });
    const params = new URLSearchParams({ x1, y1, x2, y2, z, settle_ds: settleDs, ...(timeOfDay ? { time_of_day: timeOfDay } : {}) });
    onPhase?.('boot');
    let last = '';
    const r = await run(exe('DreamDaemon'), ['probe.dmb', '-safe', '-invisible', '-ip', '127.0.0.1', '-params', params.toString(), '-log', 'devtools_world.log'],
      { cwd: dir, env, timeoutMs, onTick: async () => { const p = await readFile(path.join(dir, 'devtools_phase.txt'), 'utf8').catch(() => ''); if (p && p !== last) { last = p; onPhase?.(p.trim()); } } });
    const log = await readFile(path.join(dir, 'devtools_world.log'), 'utf8').catch(() => '');
    const runtime = (r.out + log).slice(-20000);
    let dump;
    try { dump = JSON.parse(await readFile(path.join(dir, 'devtools_ingame.json'), 'utf8')); }
    catch { return { status: 'run-failed', compiler, runtime, timedOut: r.timedOut, seconds: (Date.now() - started) / 1000 }; }
    if (dump.failure) return { status: 'probe-failed', failure: dump.failure, compiler, runtime, seconds: (Date.now() - started) / 1000 };
    // Inline exported icons so the dump stands alone.
    for (const row of dump.icons) row.base64 = row.file ? (await readFile(path.join(dir, row.file))).toString('base64') : null;
    dump.provenance = { dme, dmeSha256: src.dmeSha256, map: map ?? null, profile, timeOfDay: timeOfDay ?? null, truthLayer: 'native-initialized-world' };
    return { status: 'ok', dump, compiler, runtime, dir: keepDir ? dir : undefined, seconds: (Date.now() - started) / 1000,
      runtimeErrors: (runtime.match(/runtime error:/g) || []).length };
  } finally { if (!keepDir) await rm(dir, { recursive: true, force: true }); }
}

/**
 * Check the shape of an appearance dump (from recordIngame, or a live game such as Civ13's
 * character_view) before rendering it. Throws a TypeError naming the problem.
 */
export function validateDump(dump, { maxTiles = 64 * 64 } = {}) {
  if (!dump || typeof dump !== 'object' || Array.isArray(dump)) throw new TypeError('dump must be an object');
  const r = dump.region;
  if (!Array.isArray(r) || r.length !== 5 || !r.every(v => Number.isSafeInteger(v) && v >= 1)) throw new TypeError('dump.region must be [x1, y1, x2, y2, z] positive integers');
  if (r[2] < r[0] || r[3] < r[1] || (r[2] - r[0] + 1) * (r[3] - r[1] + 1) > maxTiles) throw new TypeError(`dump.region must be non-empty and at most ${maxTiles} tiles`);
  if (!Number.isSafeInteger(dump.icon_size) || dump.icon_size < 1 || dump.icon_size > 256) throw new TypeError('dump.icon_size must be an integer from 1 to 256');
  for (const key of ['appearances', 'icons', 'cells']) if (!Array.isArray(dump[key])) throw new TypeError(`dump.${key} must be an array`);
  for (const a of dump.appearances) if (!a || typeof a !== 'object' || !Array.isArray(a.overlays) || !Array.isArray(a.underlays)) throw new TypeError('each dump appearance needs overlays and underlays arrays');
  for (const c of dump.cells) if (!Array.isArray(c) || c.length < 5 || !Array.isArray(c[4])) throw new TypeError('each dump cell must be [x, y, area, turf, movables, ...]');
  if (dump.plane_masters !== undefined && !Array.isArray(dump.plane_masters)) throw new TypeError('dump.plane_masters must be an array');
  return dump;
}

/**
 * Decode a dump's icons (by dump icon index - 1): inline base64 bytes first, else the row's
 * `source` resource read from the project (contained in root). A missing or unreadable icon is
 * null, which the renderer counts as missing-icon.
 */
export async function loadDumpIcons(dump, root = null) {
  const out = [];
  for (const row of dump.icons) {
    let dmi = null;
    try {
      if (row?.base64) dmi = decodeDmi(Buffer.from(String(row.base64), 'base64'), { plainPng: true });
      else if (root && typeof row?.source === 'string' && row.source) dmi = decodeDmi((await readProjectBytes(root, row.source)).data, { plainPng: true });
    } catch { dmi = null; }
    out.push(dmi);
  }
  return out;
}

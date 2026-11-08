/**
 * Native compiler and local playtest for a project checkout. Distinct from static validation:
 * `compileProject` runs DreamMaker only (no game code); `playtest` RUNS THE GAME.
 *
 * Both work in a fresh temporary folder from a probe .dme that includes the checkout's files by
 * absolute path, so nothing is written to the checkout. A playtest boots DreamDaemon in -safe
 * mode bound to 127.0.0.1, with only the checkout's config/ copied in and no save data, so it
 * cannot touch a live server or its persistence. It stops at a time limit, on abort, or when
 * the world shuts down, and reports runtime errors (with source lines) and an optional proc profile.
 */
import { mkdtemp, writeFile, readFile, rm, cp, stat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { probeSource, run } from './ingame.js';
import { parseCompilerOutput, parseRuntimeErrors, summarizeProfile } from './devrun.js';

const exe = (binDir, name) => path.join(binDir, process.platform === 'win32' ? (name === 'DreamMaker' ? 'dm.exe' : 'dd.exe') : name);
const envFor = binDir => ({ ...process.env, LD_LIBRARY_PATH: [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) });

/**
 * Compile the project (optionally with another map selected). Returns {status: 'ok'|'failed',
 * diagnostics, errors, warnings, seconds, dmbBytes, dir?}. `keepDir` keeps the temp folder.
 */
export async function compileProject({ root, dme, map, binDir, probe = 'none', keepDir = false, timeoutMs = 1800000 }) {
  if (!binDir) throw new Error('binDir (BYOND bin directory) is required');
  const started = Date.now();
  const src = await probeSource({ root, dme, map, probe });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'byond-compile-'));
  let keep = false;
  try {
    await writeFile(path.join(dir, 'probe.dme'), src.text);
    const c = await run(exe(binDir, 'DreamMaker'), ['-max_errors', '0', 'probe.dme'], { cwd: dir, env: envFor(binDir), timeoutMs });
    const report = parseCompilerOutput(c.out, { root: src.projectRoot });
    const dmbBytes = await stat(path.join(dir, 'probe.dmb')).then(s => s.size, () => null);
    const ok = c.code === 0 && report.errors === 0 && dmbBytes !== null && !c.timedOut;
    keep = keepDir && ok;
    return { status: ok ? 'ok' : 'failed', exitCode: c.code, timedOut: c.timedOut, ...report, dmbBytes, seconds: (Date.now() - started) / 1000,
      dme, map: map ?? null, dmeSha256: src.dmeSha256, ...(keep ? { dir } : {}), ...(ok ? {} : { tail: c.out.split(/\r?\n/).slice(-15).join('\n') }) };
  } finally { if (!keep) await rm(dir, { recursive: true, force: true }); }
}

/** A free TCP port on 127.0.0.1 (the OS picks it). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer(); srv.unref(); srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/**
 * Compile with the playtest probe and boot DreamDaemon for a human to join with Dream Seeker.
 * Resolves after the world stops: {status, port, url, compile, runtime, profile, state, seconds, logTail}.
 * `onReady({port, url})` fires when the world opens its port; `signal` (AbortSignal) stops it early.
 */
export async function playtest({ root, dme, map, binDir, port, minutes = 30, profileProcs = false, signal, onReady, onLog }) {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) throw new RangeError('minutes must be between 0 and 1440');
  const started = Date.now();
  const compile = await compileProject({ root, dme, map, binDir, probe: 'playtest', keepDir: true });
  if (compile.status !== 'ok') return { status: 'compile-failed', compile, seconds: (Date.now() - started) / 1000 };
  const dir = compile.dir; delete compile.dir;
  try {
    const config = path.join(path.dirname(path.resolve(root, dme)), 'config');
    if (await stat(config).then(s => s.isDirectory(), () => false)) await cp(config, path.join(dir, 'config'), { recursive: true });
    port ??= await freePort();
    const params = new URLSearchParams({ devtools_minutes: String(minutes), devtools_profile: profileProcs ? '1' : '0' });
    const child = spawn(exe(binDir, 'DreamDaemon'), ['probe.dmb', String(port), '-safe', '-invisible', '-ip', '127.0.0.1', '-params', params.toString(), '-log', 'devtools_world.log'],
      { cwd: dir, env: envFor(binDir), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', ready = false, aborted = false, logSize = 0, finishing = false;
    const checkReady = text => {
      const m = !ready && /World opened on network port (\d+)/.exec(text);
      if (m) { ready = true; onReady?.({ port: Number(m[1]), url: `byond://127.0.0.1:${m[1]}` }); }
    };
    const collect = d => { out += d; if (out.length > 4e6) out = out.slice(-2e6); checkReady(out); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    // DreamDaemon writes the world log to the -log file; tail it for readiness and live output.
    const tail = setInterval(async () => {
      const log = await readFile(path.join(dir, 'devtools_world.log'), 'utf8').catch(() => '');
      if (log.length > logSize) {
        onLog?.(log.slice(logSize)); logSize = log.length; checkReady(log);
        // DreamDaemon can take ~20 s to exit after shutdown(); the probe has already saved its state.
        if (!finishing && /byond-devtools: playtest time limit/.test(log)) { finishing = true; setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }
      }
    }, 1000);
    // The probe's clock starts once world/New has finished (Civ13 takes about a minute to load);
    // hard-stop well after that in case the world hangs.
    let hardStopped = false;
    const hard = setTimeout(() => { hardStopped = true; child.kill('SIGKILL'); }, (minutes + 10) * 60000);
    const onAbort = () => { aborted = true; child.kill(); setTimeout(() => child.kill('SIGKILL'), 10000).unref(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const code = await new Promise(resolve => { child.on('close', resolve); child.on('error', () => resolve(-1)); });
    clearInterval(tail); clearTimeout(hard); signal?.removeEventListener('abort', onAbort);
    const log = await readFile(path.join(dir, 'devtools_world.log'), 'utf8').catch(() => '');
    const state = JSON.parse(await readFile(path.join(dir, 'devtools_playtest.json'), 'utf8').catch(() => 'null'));
    const profile = profileProcs ? summarizeProfile(await readFile(path.join(dir, 'devtools_profile.json'), 'utf8').catch(() => 'null')) : null;
    const all = out + '\n' + log;
    const opened = /World opened on network port (\d+)/.exec(all);
    return { status: aborted ? 'stopped' : hardStopped ? 'hard-stopped' : opened ? 'finished' : 'boot-failed', exitCode: code, port: opened ? Number(opened[1]) : port, url: opened ? `byond://127.0.0.1:${opened[1]}` : null,
      compile, runtime: parseRuntimeErrors(log, { root: await realpath(root) }), profile, state, seconds: (Date.now() - started) / 1000, logTail: log.slice(-4000) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

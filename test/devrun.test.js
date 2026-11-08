import test from 'node:test'; import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { parseCompilerOutput, parseRuntimeErrors, summarizeProfile } from '../src/devrun.js';
import { compileProject, playtest, freePort } from '../src/devrun-project.js';
import { probeSource } from '../src/ingame.js';

// Recorded from DreamMaker / DreamDaemon 516.1688 (fixtures/playtest).
const COMPILER = `DM compiler version 516.1688
loading probe.dme
/home/u/proj/code/broken.dm:3:error: missing_var: undefined var
/home/u/proj/code/broken.dm:2:warning (unused_var): unused: variable defined but not used
C:\\Proj\\code\\x.dm:9:error: bad thing
probe.dmb - 2 errors, 1 warning (11/8/26 3:03 am)
Total time: 0:00`;
const LOG = `Sun Nov  8 03:03:39 2026
World opened on network port 57733 for address 127.0.0.1.
booted
runtime error: Cannot read null.value
proc name: boom (/obj/thing/proc/boom)
  source file: /home/u/proj/code/world.dm,7
  usr: null
  src: the thing (/obj/thing)
  src.loc: null
  call stack:
the thing (/obj/thing): boom()
try boom(the thing (/obj/thing))
world: New()
runtime error: Cannot read null.value
proc name: boom (/obj/thing/proc/boom)
  source file: /home/u/proj/code/world.dm,7
  usr: null
  src: the thing (/obj/thing)
  src.loc: null
  call stack:
the thing (/obj/thing): boom()
world: New()
{"ok":1}
runtime error: list index out of bounds
proc name: other (/proc/other)
  usr: null
  src: null
  call stack:
other()
after the stack`;

test('compiler output becomes project-relative diagnostics with codes and the summary counts', () => {
  const r = parseCompilerOutput(COMPILER, { root: '/home/u/proj' });
  assert.deepEqual(r.diagnostics[0], { file: 'code/broken.dm', line: 3, severity: 'error', code: null, message: 'missing_var: undefined var' });
  assert.deepEqual(r.diagnostics[1], { file: 'code/broken.dm', line: 2, severity: 'warning', code: 'unused_var', message: 'unused: variable defined but not used' });
  assert.equal(r.errors, 2); assert.equal(r.warnings, 1); assert.equal(r.summary, true);
  // Windows paths fold case and backslashes before the root is stripped.
  assert.equal(parseCompilerOutput(COMPILER, { root: 'c:/proj' }).diagnostics[2].file, 'code/x.dm');
});
test('runtime errors are grouped by message and location, with source lines and stacks', () => {
  const r = parseRuntimeErrors(LOG, { root: '/home/u/proj' });
  assert.equal(r.total, 3); assert.equal(r.unique.length, 2); assert.equal(r.truncated, false);
  assert.deepEqual(r.unique[0], { message: 'Cannot read null.value', proc: 'boom (/obj/thing/proc/boom)', file: 'code/world.dm', line: 7, src: 'the thing (/obj/thing)', usr: 'null',
    callStack: ['the thing (/obj/thing): boom()', 'try boom(the thing (/obj/thing))', 'world: New()'], count: 2 });
  assert.deepEqual(r.unique[1].callStack, ['other()']); // 'after the stack' is ordinary log output
  assert.equal(r.unique[1].file, null); // without DEBUG BYOND prints no source line
  const capped = parseRuntimeErrors(LOG, { limit: 1 });
  assert.equal(capped.unique.length, 1); assert.equal(capped.truncated, true);
});
test('profile summaries sort by total time', () => {
  const p = summarizeProfile('[{"name":"/a","self":1,"total":1,"calls":2},{"name":"/b","self":0.5,"total":3,"calls":1}]', { top: 1 });
  assert.deepEqual(p, [{ proc: '/b', calls: 1, selfSeconds: 0.5, totalSeconds: 3, realSeconds: null, overtime: null }]);
  assert.equal(summarizeProfile('not json'), null);
});
test('the playtest probe is appended with DEBUG, and freePort finds a port', async () => {
  const src = await probeSource({ root: 'fixtures/playtest', dme: 'playtest.dme', probe: 'playtest' });
  assert.match(src.text, /#define DEBUG/); assert.match(src.text, /devtools_minutes/);
  assert.doesNotMatch((await probeSource({ root: 'fixtures/playtest', dme: 'playtest.dme', probe: 'none' })).text, /probe ----|DEBUG/);
  const port = await freePort(); assert.ok(port > 0 && port < 65536);
});

const bin = process.env.BYOND_BIN;
test('live: compile reports errors and warnings, and writes nothing to the project (set BYOND_BIN)', { skip: bin ? false : 'BYOND_BIN not set' }, async () => {
  const before = await readdir('fixtures/playtest', { recursive: true });
  const bad = await compileProject({ root: 'fixtures/playtest', dme: 'broken.dme', binDir: bin });
  assert.equal(bad.status, 'failed'); assert.equal(bad.errors, 1); assert.equal(bad.warnings, 1);
  assert.deepEqual(bad.diagnostics.map(d => [d.file, d.line, d.severity]), [['code/broken.dm', 3, 'error'], ['code/broken.dm', 2, 'warning']]);
  const ok = await compileProject({ root: 'fixtures/playtest', dme: 'playtest.dme', binDir: bin });
  assert.equal(ok.status, 'ok'); assert.ok(ok.dmbBytes > 0);
  assert.deepEqual(await readdir('fixtures/playtest', { recursive: true }), before);
});
test('live: a playtest boots on 127.0.0.1, stops at its time limit and reports runtime errors (set BYOND_BIN)', { skip: bin ? false : 'BYOND_BIN not set', timeout: 120000 }, async () => {
  let ready = null;
  const r = await playtest({ root: 'fixtures/playtest', dme: 'playtest.dme', binDir: bin, minutes: 0.05, profileProcs: true, onReady: x => { ready = x; } });
  assert.equal(r.status, 'finished'); assert.match(ready.url, /^byond:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(r.runtime.total, 3);
  assert.deepEqual([r.runtime.unique[0].file, r.runtime.unique[0].line, r.runtime.unique[0].count], ['code/world.dm', 7, 3]);
  assert.equal(r.state.reason, 'time limit');
  assert.ok(r.profile.some(p => p.proc === '/obj/thing/proc/boom' && p.calls === 3));
  const ac = new AbortController();
  const stopped = await playtest({ root: 'fixtures/playtest', dme: 'playtest.dme', binDir: bin, minutes: 5, signal: ac.signal, onReady: () => ac.abort() });
  assert.equal(stopped.status, 'stopped');
});

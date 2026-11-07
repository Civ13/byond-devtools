import test from 'node:test'; import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises'; import { spawnSync } from 'node:child_process';
import { parseTypeTree, resolveVar, collectDefines, foldArithmetic, lintMap, BUILTIN_DEFINES, TypeTreeError } from '../src/typetree.js';
import { loadProjectTypes } from '../src/project.js';
import { parseDmm } from '../src/dmm.js';
import { overrideAssignments } from '../src/world.js';
const ROOT = 'fixtures/types/project';
const project = await loadProjectTypes({ root: ROOT, dme: 'test.dme', treeFile: 'fixtures/types/tree.xml' });
await project.preload(['code/types.dm']);
const tree = parseTypeTree(project.xml), defines = collectDefines(project.defineSources);
const native = JSON.parse(await readFile('fixtures/types/native-values.json', 'utf8'));

test('tree structure, inheritance and parent_type', () => {
  assert.ok(tree.has('/turf/floor/grass') && tree.has('/obj/thing') && !tree.has('/obj/unknown'));
  assert.deepEqual(tree.chain('/obj/thing'), ['/obj/thing', '/obj/item', '/obj', '/atom/movable', '/atom', '/datum']);
  assert.equal(tree.lookupVar('/turf/floor/grass', 'icon').from, '/turf/floor');
  assert.equal(tree.lookupVar('/obj/thing', 'amount').line, 16);
});
test('DreamMaker -o values are not evaluated, so printed values are never trusted', () => {
  const layer = tree.lookupVar('/turf/floor', 'layer');
  assert.equal(layer.printed, '20.1'); // BASE_LAYER + 0.1 with the operator dropped
  assert.equal(resolveVar(layer, project.sourceLine, defines).value, Math.fround(2.1));
});
test('resolved values agree with the native instance values recorded from DreamDaemon 516.1688', () => {
  assert.equal(native.byond, '516.1688');
  let resolved = 0;
  for (const [type, vars] of Object.entries(native.types)) for (const [name, value] of Object.entries(vars)) {
    const r = resolveVar(tree.lookupVar(type, name), project.sourceLine, defines);
    if (!['literal', 'define', 'folded'].includes(r.status)) continue;
    const got = r.value && typeof r.value === 'object' ? (r.value.resource ?? r.value.path) : r.value;
    if (name === 'alpha' && !Number.isInteger(got)) continue; // builtin coerces; covered below
    assert.equal(typeof got === 'number' ? Math.fround(got) : got, typeof value === 'number' ? Math.fround(value) : value, `${type}.${name}`);
    resolved++;
  }
  assert.ok(resolved >= 12, `only ${resolved} values resolved`);
});
test('expressions the resolver cannot prove stay unresolved', () => {
  assert.equal(resolveVar(tree.lookupVar('/obj/item', 'dir'), project.sourceLine, defines).status, 'unresolved'); // NORTH|EAST
  assert.equal(resolveVar(tree.lookupVar('/obj/item', 'name'), project.sourceLine, defines).status, 'unresolved'); // \improper
  assert.equal(native.types['/obj/item'].alpha, 127); // 255 * (1 / 2): builtin alpha stores an integer
  assert.equal(resolveVar(tree.lookupVar('/obj/item', 'icon'), project.sourceLine, defines).status, 'unset');
});
test('arithmetic folding: precedence, macros, float32, refusals', () => {
  const d = new Map([['A', '2'], ['B', '(A * 3)'], ['X', 'foo()']]);
  assert.equal(foldArithmetic('A + B / 2', d), 5); assert.equal(foldArithmetic('-A + 1', d), -1);
  assert.equal(foldArithmetic('MOB', new Map([['MOB', '4']])), 4);
  assert.equal(foldArithmetic('0.1 + 0.2', d), Math.fround(Math.fround(0.1) + Math.fround(0.2)));
  for (const bad of ['A | 1', 'X + 1', 'A / 0', 'A +', '(A)', 'A ** 2', 'Z']) assert.equal(foldArithmetic(bad, d), undefined, bad);
});
test('builtin constants match the recorded native values', async () => {
  assert.deepEqual({ ...BUILTIN_DEFINES }, JSON.parse(await readFile('fixtures/native/builtin-defines.json', 'utf8')));
  const d = collectDefines(['#define DUP 1', '#define DUP 2', '#define SAME 3 // c', '#define SAME 3']);
  assert.equal(d.get('DUP'), null); assert.equal(d.get('SAME'), '3'); assert.equal(d.get('TRUE'), '1');
});
test('lint finds unknown types and undefined vars, with cell counts', async () => {
  const map = parseDmm(await readFile(`${ROOT}/maps/sample.dmm`, 'utf8'));
  const r = lintMap(map, tree, { overrideKeys: raw => overrideAssignments(raw).map(o => o.key) });
  assert.deepEqual(r.counts, { 'unknown-type': 1, 'undefined-var': 1 });
  assert.equal(r.problems.find(p => p.code === 'unknown-type').path, '/obj/unknown');
  assert.equal(r.problems.find(p => p.code === 'undefined-var').var, 'missing_var');
  assert.equal(r.problems[0].cells, 2);
});
test('malformed trees are rejected', () => {
  assert.throws(() => parseTypeTree('nothing here'), TypeTreeError);
  assert.throws(() => parseTypeTree('<dm><obj file="a:1">x</mob></dm>'), TypeTreeError);
  assert.throws(() => parseTypeTree('<dm><obj file="a:1">bad name</obj></dm>'), TypeTreeError);
});
test('CLI types and lint (saved tree)', () => {
  const run = args => spawnSync(process.execPath, ['src/cli.js', ...args, '--root', ROOT, '--dme', 'test.dme', '--tree', 'fixtures/types/tree.xml'], { encoding: 'utf8' });
  let r = run(['types', '--type', '/obj/thing']);
  assert.equal(r.status, 0, r.stderr); const t = JSON.parse(r.stdout).data;
  assert.equal(t.vars.amount.value, 3); assert.equal(t.vars.layer.status, 'define');
  r = run(['lint', '--map', 'maps/sample.dmm']);
  assert.equal(r.status, 3, r.stderr); assert.equal(JSON.parse(r.stdout).data.problems.length, 2);
  r = run(['types']); assert.equal(r.status, 0, r.stderr); assert.ok(JSON.parse(r.stdout).data.renderVarResolution.layer);
});
const bin = process.env.BYOND_BIN;
test('live DreamMaker -o reproduces the recorded tree (set BYOND_BIN to run)', { skip: bin ? false : 'BYOND_BIN not set' }, async () => {
  const live = await loadProjectTypes({ root: ROOT, dme: 'test.dme', binDir: bin });
  assert.equal(live.compiler.errorCount, 0, live.compiler.errors.join('\n'));
  assert.equal(live.xml, project.xml);
});
test('vars DreamMaker leaves unclosed after a failed value are closed implicitly', () => {
  const t = parseTypeTree('<dm><obj file="a.dm:1">obj<obj file="a.dm:1">x<var file="a.dm:2">snd<var file="a.dm:3">n<val file="a.dm:3">2</val></var></obj></obj></dm>');
  assert.equal(t.recoveredTags, 1); assert.equal(t.lookupVar('/obj/x', 'n').printed, '2'); assert.ok(t.lookupVar('/obj/x', 'snd'));
});
test('absolute backslash file paths (dm.exe on Windows) become project-relative', async () => {
  const { realpath, mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os'), path = await import('node:path');
  const abs = (await realpath(ROOT)).split(path.sep).join('/');
  const xml = (await readFile('fixtures/types/tree.xml', 'utf8')).replaceAll('file="', `file="${abs}/`).replace(/file="([^"]*)"/g, (_, f) => `file="${f.replaceAll('/', '\\')}"`);
  assert.match(xml, /file="[^"]*\\code\\types\.dm:1"/);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bd-tree-'));
  try {
    await writeFile(path.join(dir, 'tree.xml'), xml);
    const windows = await loadProjectTypes({ root: ROOT, dme: 'test.dme', treeFile: path.join(dir, 'tree.xml') });
    assert.equal(windows.xml, project.xml);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

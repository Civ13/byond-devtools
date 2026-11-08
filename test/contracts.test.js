import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os'; import path from 'node:path';
import { parseDmm } from '../src/dmm.js';
import { checkContract, validateContract, needsTypes, ContractError } from '../src/contracts.js';

// 6x5 map, south row last. W = wall, D = door, f = floor (room area), o = outside, S = spawn mark.
//   oooooo
//   oWWWWo
//   oWfSWo
//   oWWDWo
//   oooooo
const DMM = [
  '"o" = (/turf/grass,/area/out)', '"W" = (/turf/wall,/area/room)', '"f" = (/turf/floor,/area/room)',
  '"S" = (/obj/mark,/turf/floor,/area/room)', '"D" = (/obj/door{density = 1},/turf/floor,/area/room)',
  '(1,1,1) = {"', 'oooooo', 'oWWWWo', 'oWfSWo', 'oWWDWo', 'oooooo', '"}', ''].join('\n');
const map = parseDmm(DMM);
const C = rules => ({ kind: 'byond-devtools-contract', schemaVersion: 1, actors: { walker: { blocking: { paths: ['/turf/wall'] }, dense: true }, ghost: { blocking: { paths: ['/turf/nothing'] } } }, rules });
const isDense = a => a.path === '/obj/door';
const ROOM = { x1: 2, y1: 2, x2: 5, y2: 4, z: 1 };

test('require, forbid and area count atoms in a region', () => {
  const r = checkContract(map, C([
    { id: 'mark', type: 'require', region: ROOM, match: { paths: ['/obj/mark'] }, min: 1, max: 1 },
    { id: 'two-marks', type: 'require', region: ROOM, match: { paths: ['/obj/mark'] }, min: 2 },
    { id: 'no-grass', type: 'forbid', region: ROOM, match: { paths: ['/turf/grass'] } },
    { id: 'no-walls', type: 'forbid', region: ROOM, match: { paths: ['/turf'] } },
    { id: 'room-area', type: 'area', region: { x1: 3, y1: 3, x2: 4, y2: 3, z: 1 }, match: { paths: ['/area/room'] } },
    { id: 'all-room', type: 'area', region: { x1: 1, y1: 1, x2: 6, y2: 5, z: 1 }, match: { paths: ['/area/room'] } },
  ]), { isDense });
  assert.deepEqual(r.results.map(x => [x.id, x.passed]), [['mark', true], ['two-marks', false], ['no-grass', true], ['no-walls', false], ['room-area', true], ['all-room', false]]);
  assert.equal(r.results[1].found, 1); assert.equal(r.results[5].outside, 18); assert.equal(r.failed, 3);
  assert.deepEqual(r.results[0].examples, [{ x: 4, y: 3, z: 1, path: '/obj/mark' }]);
});
test('routes follow the actor: dense doors block a walker, passable doors do not', () => {
  const inside = { x: 3, y: 3, z: 1 }, out = { x: 1, y: 1, z: 1 };
  const r = checkContract(map, C([
    { id: 'walker-stuck', type: 'unreachable', from: inside, to: out, actor: 'walker' },
    { id: 'door-opener', type: 'reachable', from: inside, to: out, actor: { blocking: { paths: ['/turf/wall'] }, dense: true, passable: { paths: ['/obj/door'] } } },
    { id: 'sealed', type: 'enclosed', seed: inside, region: ROOM, actor: 'walker' },
    { id: 'leaky', type: 'enclosed', seed: inside, region: { x1: 3, y1: 3, x2: 4, y2: 3, z: 1 }, actor: { blocking: { paths: ['/turf/wall'] } } },
  ]), { isDense });
  const [stuck, opener, sealed, leaky] = r.results;
  assert.equal(stuck.passed, true); assert.equal(stuck.found, false); assert.equal(stuck.explored, 2);
  assert.equal(opener.passed, true); assert.equal(opener.steps, 6);
  assert.deepEqual(opener.route, ['3,3', '4,3', '4,2', '4,1', '3,1', '2,1', '1,1']);
  assert.equal(sealed.passed, true);
  assert.equal(leaky.passed, false); assert.deepEqual(leaky.leak, { x: 4, y: 2, z: 1, via: { x: 4, y: 3, z: 1 } });
});
test('a blocked endpoint, diagonal corner cutting and maxSteps are reported', () => {
  const r = checkContract(map, C([
    { id: 'into-wall', type: 'reachable', from: { x: 1, y: 1, z: 1 }, to: { x: 2, y: 2, z: 1 }, actor: 'ghost' },
    { id: 'short', type: 'reachable', from: { x: 1, y: 1, z: 1 }, to: { x: 6, y: 5, z: 1 }, actor: { blocking: { paths: ['/turf/wall'] }, maxSteps: 3 } },
    { id: 'diag', type: 'reachable', from: { x: 1, y: 1, z: 1 }, to: { x: 6, y: 5, z: 1 }, actor: { blocking: { paths: ['/turf/wall'] }, diagonal: true } },
  ]));
  assert.equal(r.results[0].passed, true); // the ghost walks through walls ('/turf/nothing' blocks)
  assert.equal(r.results[1].passed, false); assert.equal(r.results[1].stoppedAtMaxSteps, true);
  assert.equal(r.results[2].passed, true); assert.equal(r.results[2].steps, 9); // corners of walls cannot be cut
  const blocked = checkContract(map, C([{ id: 'b', type: 'reachable', from: { x: 1, y: 1, z: 1 }, to: { x: 2, y: 2, z: 1 }, actor: { blocking: { paths: ['/turf/wall'] } } }]));
  assert.equal(blocked.results[0].toBlocked, '/turf/wall');
});
test('bad contracts are refused before checking', () => {
  assert.throws(() => validateContract({ kind: 'x' }), ContractError);
  assert.throws(() => checkContract(map, C([{ type: 'teleport' }])), /type must be/);
  assert.throws(() => checkContract(map, C([{ id: 'a', type: 'forbid', region: ROOM, match: { paths: ['/x'] } }, { id: 'a', type: 'forbid', region: ROOM, match: { paths: ['/x'] } }])), /duplicate id/);
  assert.throws(() => checkContract(map, C([{ type: 'forbid', region: { ...ROOM, x2: 99 }, match: { paths: ['/x'] } }])), /outside the map/);
  assert.throws(() => checkContract(map, C([{ type: 'reachable', from: { x: 1, y: 1, z: 1 }, to: { x: 2, y: 1, z: 1 }, actor: 'walker' }])), /needs the native type tree/);
  assert.throws(() => checkContract(map, C([{ type: 'reachable', from: { x: 1, y: 1, z: 1 }, to: { x: 2, y: 1, z: 1 }, actor: 'nobody' }])), /unknown actor/);
  assert.equal(needsTypes(C([{ type: 'reachable', actor: 'walker' }])), true);
  assert.equal(needsTypes(C([{ type: 'reachable', actor: 'ghost' }])), false);
});
test('CLI: check exits 3 on failure, and edit --contract refuses a write that breaks it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bd-contract-'));
  try {
    await mkdir(path.join(dir, 'maps')); await writeFile(path.join(dir, 'maps', 'm.dmm'), DMM);
    const contract = C([{ id: 'sealed', type: 'enclosed', seed: { x: 3, y: 3, z: 1 }, region: ROOM, actor: { blocking: { paths: ['/turf/wall', '/obj/door'] } } }]);
    delete contract.actors.walker;
    await writeFile(path.join(dir, 'c.json'), JSON.stringify(contract));
    const run = (...a) => spawnSync(process.execPath, ['src/cli.js', ...a, '--root', dir], { encoding: 'utf8' });
    const ok = run('check', '--map', 'maps/m.dmm', '--contract', path.join(dir, 'c.json'));
    assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).data.passed, 1);
    const base = createHash('sha256').update(DMM).digest('hex');
    await writeFile(path.join(dir, 'p.json'), JSON.stringify({ base, edits: [{ x: 3, y: 4, z: 1, expect: ['/turf/wall', '/area/room'], set: ['/turf/floor', '/area/room'] }] }));
    const dry = run('edit', '--map', 'maps/m.dmm', '--patch', path.join(dir, 'p.json'), '--contract', path.join(dir, 'c.json'));
    assert.equal(dry.status, 3); assert.equal(JSON.parse(dry.stdout).data.postcondition.failed, 1);
    const apply = run('edit', '--map', 'maps/m.dmm', '--patch', path.join(dir, 'p.json'), '--contract', path.join(dir, 'c.json'), '--apply');
    assert.equal(apply.status, 1); assert.match(apply.stderr, /Postcondition failed/);
    assert.equal(await readFile(path.join(dir, 'maps', 'm.dmm'), 'utf8'), DMM);
    const bad = run('check', '--map', 'maps/m.dmm', '--contract', path.join(dir, 'c.json'));
    assert.equal(bad.status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

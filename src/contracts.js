/**
 * Spatial contracts: declarative checks over map regions. Pure: parsed map in, report out.
 *
 * A contract is JSON: {kind: 'byond-devtools-contract', schemaVersion: 1, actors?: {...}, rules: [...]}.
 * Rules (every region is {x1, y1, x2, y2, z}; `match` is {paths: [...], subtypes?: true}):
 *   require    region, match, min?, max?   count of matching atoms is within [min, max] (min default 1)
 *   forbid     region, match               no matching atom in the region
 *   area       region, match               every authored tile's area matches
 *   reachable  from, to, actor             a walk exists from `from` to `to` (4-way unless the actor says diagonal)
 *   enclosed   seed, region, actor         a walk from `seed` never leaves `region` (a sealed room)
 *   unreachable from, to, actor            no walk exists (a wall really separates two places)
 *
 * An actor states what blocks movement, so a route result is only as good as its assumptions:
 *   {blocking: match, passable?: match, dense?: true, diagonal?: false, maxSteps?: N}
 * `dense: true` treats atoms whose type default or override `density` is true as blocking;
 * that needs `isDense(atom)` from the caller (resolved from the native type tree). `passable`
 * wins over both (for example doors an actor can open). Holes (no authored tile) block.
 * Nothing here runs game code: Bump(), CanPass(), doors that lock and runtime spawns are not modelled.
 */
import { overrideAssignments } from './world.js';
import { resolveVar } from './typetree.js';

export class ContractError extends Error { constructor(message) { super(message); this.name = 'ContractError'; } }

const MAX_CELLS = 4 * 1024 * 1024;
const RULES = ['require', 'forbid', 'area', 'reachable', 'enclosed', 'unreachable'];

function matcher(m, where) {
  if (!m || !Array.isArray(m.paths) || !m.paths.length || !m.paths.every(p => typeof p === 'string' && /^\/[A-Za-z0-9_/]+$/.test(p))) throw new ContractError(`${where}: match needs paths: ["/type", ...]`);
  const subtypes = m.subtypes !== false;
  return path => m.paths.some(p => path === p || (subtypes && path.startsWith(p + '/')));
}
function checkRegion(r, map, where) {
  if (!r || ![r.x1, r.y1, r.x2, r.y2, r.z].every(v => Number.isSafeInteger(v) && v >= 1)) throw new ContractError(`${where}: region needs positive integers x1, y1, x2, y2, z`);
  if (r.x2 < r.x1 || r.y2 < r.y1) throw new ContractError(`${where}: empty region`);
  if ((r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1) > MAX_CELLS) throw new ContractError(`${where}: region too large`);
  if (r.x2 > map.world.maxX || r.y2 > map.world.maxY || r.z > map.world.maxZ) throw new ContractError(`${where}: region outside the map`);
}
function checkPoint(p, map, where) {
  if (!p || ![p.x, p.y, p.z].every(v => Number.isSafeInteger(v) && v >= 1) || p.x > map.world.maxX || p.y > map.world.maxY || p.z > map.world.maxZ) throw new ContractError(`${where}: point needs x, y, z inside the map`);
}
const truthy = raw => /^(1|TRUE)$/.test(String(raw).trim());

function makeActor(spec, isDense, where) {
  if (!spec || typeof spec !== 'object') throw new ContractError(`${where}: actor missing`);
  const blocking = spec.blocking ? matcher(spec.blocking, `${where}.blocking`) : () => false;
  const passable = spec.passable ? matcher(spec.passable, `${where}.passable`) : () => false;
  if (spec.dense && typeof isDense !== 'function') throw new ContractError(`${where}: dense: true needs the native type tree (--dme with --byond or --tree)`);
  if (!spec.blocking && !spec.dense) throw new ContractError(`${where}: actor needs blocking and/or dense: true`);
  const maxSteps = spec.maxSteps ?? MAX_CELLS;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new ContractError(`${where}: invalid maxSteps`);
  const cache = new Map();
  const blocks = cell => {
    if (!cell) return { blocked: true, by: 'hole' };
    if (cache.has(cell.key)) return cache.get(cell.key);
    let out = { blocked: false };
    for (const a of cell.atoms) {
      if (passable(a.path)) continue;
      const override = overrideAssignments(a.overridesRaw).find(o => o.key === 'density');
      const dense = spec.dense && (override ? truthy(override.raw) : isDense(a));
      if (blocking(a.path) || dense) { out = { blocked: true, by: a.path }; break; }
    }
    cache.set(cell.key, out); return out;
  };
  return { blocks, diagonal: !!spec.diagonal, maxSteps };
}

/** Breadth-first walk from `start`. Returns {seen: Set, parent: Map, steps, stopped, escaped?}. */
function walk(map, actor, start, { goal, bounds } = {}) {
  const key = (x, y) => `${x},${y}`, z = start.z;
  const seen = new Set([key(start.x, start.y)]), parent = new Map(), queue = [[start.x, start.y, 0]];
  const dirs = actor.diagonal ? [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[0, 1], [1, 0], [0, -1], [-1, 0]];
  let head = 0, stopped = false, escaped = null;
  while (head < queue.length) {
    const [x, y, d] = queue[head++];
    if (goal && x === goal.x && y === goal.y) return { seen, parent, steps: d, found: true };
    if (d >= actor.maxSteps) { stopped = true; continue; }
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx < 1 || ny < 1 || nx > map.world.maxX || ny > map.world.maxY) continue;
      const k = key(nx, ny); if (seen.has(k)) continue;
      // A diagonal step needs both orthogonal neighbours open, as BYOND's step does.
      if (dx && dy && (actor.blocks(map.inspectCell(x + dx, y, z)).blocked || actor.blocks(map.inspectCell(x, y + dy, z)).blocked)) continue;
      if (actor.blocks(map.inspectCell(nx, ny, z)).blocked) continue;
      seen.add(k); parent.set(k, key(x, y));
      if (bounds && (nx < bounds.x1 || nx > bounds.x2 || ny < bounds.y1 || ny > bounds.y2)) { escaped = { x: nx, y: ny, z, via: { x, y, z } }; return { seen, parent, escaped }; }
      queue.push([nx, ny, d + 1]);
    }
  }
  return { seen, parent, stopped, found: false, escaped };
}
function pathTo(parent, end, limit = 64) {
  const out = []; let k = `${end.x},${end.y}`;
  while (k && out.length < 100000) { out.push(k); k = parent.get(k); }
  out.reverse();
  return out.length > limit ? [...out.slice(0, limit / 2), '...', ...out.slice(-limit / 2)] : out;
}

/** Validate a contract and return it, or throw ContractError. */
export function validateContract(contract) {
  if (!contract || contract.kind !== 'byond-devtools-contract' || contract.schemaVersion !== 1) throw new ContractError('Not a byond-devtools contract (schemaVersion 1)');
  if (!Array.isArray(contract.rules) || !contract.rules.length) throw new ContractError('Contract has no rules');
  if (contract.rules.length > 1000) throw new ContractError('Too many rules');
  const ids = new Set();
  contract.rules.forEach((r, i) => {
    if (!RULES.includes(r?.type)) throw new ContractError(`Rule ${i}: type must be one of ${RULES.join(', ')}`);
    const id = r.id ?? `#${i}`; if (ids.has(id)) throw new ContractError(`Rule ${i}: duplicate id ${id}`); ids.add(id);
  });
  return contract;
}

/** True when the contract needs the native type tree (an actor with dense: true). */
export const needsTypes = contract => contract.rules.some(r => { const a = typeof r.actor === 'string' ? contract.actors?.[r.actor] : r.actor; return !!a?.dense; });

/**
 * Check every rule. Returns {passed, failed, results: [{id, type, passed, ...evidence}]}.
 * `isDense(atom)` (optional) reports the type default density for actors with dense: true.
 */
export function checkContract(map, contract, { isDense } = {}) {
  validateContract(contract);
  if (map.diagnostics?.length) throw new ContractError('Map has parser diagnostics');
  const results = [];
  contract.rules.forEach((rule, i) => {
    const id = rule.id ?? `#${i}`, where = `Rule ${id}`, out = { id, type: rule.type, ...(rule.description ? { description: rule.description } : {}) };
    const actorOf = () => {
      const spec = typeof rule.actor === 'string' ? contract.actors?.[rule.actor] : rule.actor;
      if (typeof rule.actor === 'string' && !spec) throw new ContractError(`${where}: unknown actor ${rule.actor}`);
      return makeActor(spec, isDense, `${where}.actor`);
    };
    if (rule.type === 'require' || rule.type === 'forbid' || rule.type === 'area') {
      checkRegion(rule.region, map, where);
      const match = matcher(rule.match, where), r = rule.region;
      let count = 0; const hits = [], misses = [];
      for (let y = r.y2; y >= r.y1; y--) for (let x = r.x1; x <= r.x2; x++) {
        const cell = map.inspectCell(x, y, r.z); if (!cell) continue;
        if (rule.type === 'area') {
          const area = cell.atoms.find(a => a.path === '/area' || a.path.startsWith('/area/'))?.path ?? '/area';
          if (!match(area)) { count++; if (misses.length < 20) misses.push({ x, y, z: r.z, area }); }
          continue;
        }
        for (const a of cell.atoms) if (match(a.path)) { count++; if (hits.length < 20) hits.push({ x, y, z: r.z, path: a.path }); }
      }
      if (rule.type === 'area') Object.assign(out, { passed: count === 0, outside: count, examples: misses });
      else if (rule.type === 'forbid') Object.assign(out, { passed: count === 0, found: count, examples: hits });
      else {
        const min = rule.min ?? 1, max = rule.max ?? Infinity;
        if (!Number.isSafeInteger(min) || min < 0 || (max !== Infinity && (!Number.isSafeInteger(max) || max < min))) throw new ContractError(`${where}: invalid min/max`);
        Object.assign(out, { passed: count >= min && count <= max, found: count, min, max: max === Infinity ? null : max, examples: hits });
      }
    } else if (rule.type === 'reachable' || rule.type === 'unreachable') {
      checkPoint(rule.from, map, `${where}.from`); checkPoint(rule.to, map, `${where}.to`);
      if (rule.from.z !== rule.to.z) throw new ContractError(`${where}: from and to must be on one z level (stairs and ladders are not modelled)`);
      const actor = actorOf();
      for (const [name, p] of [['from', rule.from], ['to', rule.to]]) { const b = actor.blocks(map.inspectCell(p.x, p.y, p.z)); if (b.blocked) out[`${name}Blocked`] = b.by; }
      const w = out.fromBlocked || out.toBlocked ? { found: false, seen: new Set() } : walk(map, actor, rule.from, { goal: rule.to });
      const found = !!w.found;
      Object.assign(out, { passed: rule.type === 'reachable' ? found : !found, found, explored: w.seen.size, ...(w.stopped ? { stoppedAtMaxSteps: true } : {}) });
      if (found) Object.assign(out, { steps: w.steps, route: pathTo(w.parent, rule.to) });
    } else {
      checkRegion(rule.region, map, where); checkPoint(rule.seed, map, `${where}.seed`);
      if (rule.seed.z !== rule.region.z) throw new ContractError(`${where}: seed must be on the region's z level`);
      const actor = actorOf(), w = walk(map, actor, rule.seed, { bounds: rule.region });
      Object.assign(out, { passed: !w.escaped, explored: w.seen.size, ...(w.escaped ? { leak: w.escaped, route: pathTo(w.parent, w.escaped) } : {}) });
    }
    results.push(out);
  });
  const failed = results.filter(r => !r.passed).length;
  return { passed: results.length - failed, failed, results };
}

/**
 * isDense(atom) from the native type tree: the type's resolved `density` default.
 * A density the resolver cannot prove counts as blocking and is listed in `unresolved`.
 */
export function densityResolver(tree, sourceLine, defines) {
  const cache = new Map(), unresolved = new Set();
  const isDense = atom => {
    if (!cache.has(atom.path)) {
      if (!tree.has(atom.path)) { unresolved.add(atom.path); cache.set(atom.path, true); }
      else {
        const r = resolveVar(tree.lookupVar(atom.path, 'density'), sourceLine, defines);
        if (r.status === 'unset') cache.set(atom.path, false);
        else if (r.status === 'unresolved') { unresolved.add(atom.path); cache.set(atom.path, true); }
        else cache.set(atom.path, !!r.value);
      }
    }
    return cache.get(atom.path);
  };
  return { isDense, unresolved };
}

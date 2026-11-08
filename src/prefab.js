/**
 * Prefabs: a rectangle of tile stacks lifted from a map, and placed into another map as an
 * ordinary edit patch. Pure: no filesystem, process or network access.
 *
 * A prefab never writes a map itself. Placing one produces a patch with the target's current
 * stacks as `expect`, so it goes through the same base-hash and stale-stack checks as `edit`,
 * and can be previewed with `diff --patch` first. Atom text is kept as authored, overrides and
 * all; nothing is evaluated.
 *
 * Prefab JSON: {kind: 'byond-devtools-prefab', schemaVersion: 1, width, height,
 *   cells: [{dx, dy, atoms: [raw, ...]}], types: [path, ...], source?}
 * dx/dy are zero-based offsets from the south-west corner. A cell that is absent is left alone
 * when placed (holes in the source, and cells removed by hand, both work this way).
 */
import { compactAtom } from './edit.js';

export class PrefabError extends Error { constructor(message) { super(message); this.name = 'PrefabError'; } }

const pathOf = raw => raw.trim().replace(/\{[\s\S]*$/, '').trim();
const kindOf = p => p === '/area' || p.startsWith('/area/') ? 'area' : p === '/turf' || p.startsWith('/turf/') ? 'turf' : 'movable';
const KINDS = ['movable', 'turf', 'area'];
const MAX_CELLS = 128 * 128;

/**
 * Lift tiles x1..x2, y1..y2 on level z. `layers` chooses what is kept per tile:
 * any of 'movable' (objs and mobs), 'turf', 'area'. Default: all three.
 */
export function extractPrefab(map, { x1, y1, x2, y2, z, layers = KINDS, source } = {}) {
  for (const v of [x1, y1, x2, y2, z]) if (!Number.isSafeInteger(v) || v < 1) throw new PrefabError('Region coordinates must be positive integers');
  if (x2 < x1 || y2 < y1) throw new PrefabError('Empty region');
  const width = x2 - x1 + 1, height = y2 - y1 + 1;
  if (width * height > MAX_CELLS) throw new PrefabError(`Prefab of ${width * height} tiles exceeds the ${MAX_CELLS}-tile limit`);
  if (!Array.isArray(layers) || !layers.length || layers.some(l => !KINDS.includes(l))) throw new PrefabError(`layers must be a list of ${KINDS.join(', ')}`);
  if (map.diagnostics?.length) throw new PrefabError('Map has parser diagnostics');
  if (x2 > map.world.maxX || y2 > map.world.maxY || z > map.world.maxZ) throw new PrefabError(`Region is outside the ${map.world.maxX}x${map.world.maxY}x${map.world.maxZ} map`);
  const cells = [], types = new Set();
  let holes = 0;
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
    const c = map.inspectCell(x, y, z);
    if (!c) { holes++; continue; }
    const atoms = c.atoms.map(a => a.raw.trim()).filter(r => layers.includes(kindOf(pathOf(r))));
    if (!atoms.length) continue;
    for (const r of atoms) types.add(pathOf(r));
    cells.push({ dx: x - x1, dy: y - y1, atoms });
  }
  return { kind: 'byond-devtools-prefab', schemaVersion: 1, width, height, layers: [...layers], cells, types: [...types].sort(),
    ...(source ? { source: { ...source, region: { x1, y1, x2, y2, z } } } : {}), holes };
}

/** Check a prefab object read from JSON; returns it unchanged or throws PrefabError. */
export function validatePrefab(p) {
  if (!p || p.kind !== 'byond-devtools-prefab' || p.schemaVersion !== 1) throw new PrefabError('Not a byond-devtools prefab (schemaVersion 1)');
  for (const k of ['width', 'height']) if (!Number.isSafeInteger(p[k]) || p[k] < 1) throw new PrefabError(`Invalid prefab ${k}`);
  if (p.width * p.height > MAX_CELLS) throw new PrefabError('Prefab too large');
  if (!Array.isArray(p.cells)) throw new PrefabError('Prefab has no cells list');
  const seen = new Set();
  p.cells.forEach((c, i) => {
    if (!Number.isSafeInteger(c?.dx) || !Number.isSafeInteger(c?.dy) || c.dx < 0 || c.dy < 0 || c.dx >= p.width || c.dy >= p.height) throw new PrefabError(`Cell ${i}: offset outside the prefab`);
    if (!Array.isArray(c.atoms) || !c.atoms.length || !c.atoms.every(a => typeof a === 'string' && a.trim().startsWith('/'))) throw new PrefabError(`Cell ${i}: atoms must be a non-empty list of atom strings`);
    const at = `${c.dx},${c.dy}`; if (seen.has(at)) throw new PrefabError(`Cell ${i}: offset ${at} listed twice`); seen.add(at);
    if (c.atoms.filter(a => kindOf(pathOf(a)) === 'area').length > 1) throw new PrefabError(`Cell ${i}: more than one area`);
  });
  return p;
}

/**
 * Place a prefab with its south-west corner at (x, y, z). Returns an edit patch
 * {base, bounds, edits, prefab: {...}}; `base` is the caller's map sha256.
 *
 * mode 'replace': each prefab cell's stack replaces the tile's, except that the tile keeps its
 *   own area when the prefab cell has none (and its own turf when the cell has none).
 * mode 'overlay': the prefab's movables are added on top of the tile's movables; a prefab
 *   turf replaces the tile's turfs and a prefab area replaces its area.
 * Cells whose result equals the current stack are skipped, so re-placing is a no-op.
 */
export function placePrefab(map, prefab, { x, y, z, mode = 'replace', base } = {}) {
  validatePrefab(prefab);
  for (const v of [x, y, z]) if (!Number.isSafeInteger(v) || v < 1) throw new PrefabError('Placement coordinates must be positive integers');
  if (!['replace', 'overlay'].includes(mode)) throw new PrefabError('mode must be replace or overlay');
  const x2 = x + prefab.width - 1, y2 = y + prefab.height - 1;
  if (x2 > map.world.maxX || y2 > map.world.maxY || z > map.world.maxZ) throw new PrefabError(`Prefab at ${x},${y},${z} (${prefab.width}x${prefab.height}) does not fit the ${map.world.maxX}x${map.world.maxY}x${map.world.maxZ} map`);
  const edits = []; let unchanged = 0;
  for (const c of prefab.cells) {
    const tx = x + c.dx, ty = y + c.dy, cell = map.inspectCell(tx, ty, z);
    if (!cell) throw new PrefabError(`No authored tile at ${tx},${ty},${z} (holes cannot be filled)`);
    const cur = cell.atoms.map(a => a.raw.trim());
    const split = list => { const o = { movable: [], turf: [], area: [] }; for (const r of list) o[kindOf(pathOf(r))].push(r); return o; };
    const have = split(cur), put = split(c.atoms);
    const turf = put.turf.length ? put.turf : have.turf, area = put.area.length ? put.area : have.area;
    const movable = mode === 'overlay' ? [...have.movable, ...put.movable] : put.movable;
    const set = [...movable, ...turf, ...area];
    if (!set.length) throw new PrefabError(`Tile ${tx},${ty},${z} would be empty`);
    if (set.map(compactAtom).join(',') === cur.map(compactAtom).join(',')) { unchanged++; continue; }
    edits.push({ x: tx, y: ty, z, expect: cur, set });
  }
  return { ...(base ? { base } : {}), bounds: { x1: x, y1: y, x2, y2, z }, maxEdits: prefab.width * prefab.height, edits,
    prefab: { width: prefab.width, height: prefab.height, mode, cells: prefab.cells.length, unchanged } };
}

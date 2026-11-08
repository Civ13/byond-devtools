/**
 * Generator-aware map inspection. Pure: map, type tree and a source-line reader in; no I/O.
 *
 * A generator is a map atom that makes or changes other content when the world starts:
 * spawners, loot drops, landmarks and similar. The static preview draws such an atom as
 * itself (often an invisible marker), so a map reader needs to know what it will produce.
 * Generators are found by type: an atom is one when its type is a subtype of a profile root.
 *
 * What a generator produces is read from its vars, never by running it: a var whose declaring
 * source line (or map override) is a type path, or a `list(...)` of type paths with optional
 * `= weight`, is reported as a spawn target. Anything else (a proc call, a computed list) is
 * reported as unresolved with its text. Whether the generator's code actually uses that var
 * is not proven; the report names the init procs (`New`, `Initialize`, ...) its type defines.
 */
import { overrideAssignments } from './world.js';
import { parseValue } from './typetree.js';

export const GENERATOR_PROFILES = Object.freeze({
  default: Object.freeze({ roots: Object.freeze(['/obj/effect/spawner', '/obj/effect/landmark']) }),
  civ13: Object.freeze({ roots: Object.freeze(['/obj/effect/spawner', '/obj/effect/landmark', '/obj/effect/autoassembler']) }),
});
const INIT_PROCS = ['New', 'Initialize', 'LateInitialize', 'spawnerproc', 'do_spawn'];
// Appearance and identity vars are not generator settings.
const SKIP = new Set(['icon', 'icon_state', 'name', 'desc', 'layer', 'plane', 'invisibility', 'anchored', 'density', 'opacity', 'dir', 'pixel_x', 'pixel_y', 'parent_type', 'mouse_opacity', 'alpha', 'color']);
const TYPE_PATH = /^\/[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Split a list(...) body on top-level commas. Returns null when quotes or brackets are unbalanced. */
function splitTop(body) {
  const out = []; let depth = 0, quote = null, part = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { part += c; if (c === '\\') { part += body[++i] ?? ''; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; part += c; continue; }
    if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    if (depth < 0) return null;
    if (c === ',' && depth === 0) { out.push(part); part = ''; continue; }
    part += c;
  }
  if (quote || depth) return null;
  out.push(part);
  return out.map(s => s.trim()).filter(Boolean);
}

/**
 * Read a spawn target expression: a type path, or list(...) of type paths with optional
 * `= weight` (DM pickweight style). Returns {types: [{path, weight}]} or null when it is not one.
 */
export function parseTypeList(raw, defines = new Map()) {
  const text = String(raw).trim();
  if (TYPE_PATH.test(text)) return { types: [{ path: text, weight: null }] };
  const m = /^list\s*\(([\s\S]*)\)$/.exec(text);
  if (!m) return null;
  const items = splitTop(m[1]);
  if (!items || !items.length) return null;
  const types = [];
  for (const item of items) {
    const w = /^(\/[A-Za-z0-9_/]+)\s*=\s*([\s\S]+)$/.exec(item);
    if (w && TYPE_PATH.test(w[1])) { const v = parseValue(w[2].trim(), defines); types.push({ path: w[1], weight: typeof v.value === 'number' ? v.value : w[2].trim() }); continue; }
    if (!TYPE_PATH.test(item)) return null;
    types.push({ path: item, weight: null });
  }
  return { types };
}

/** The full assignment text of a var: its declaring line plus continuation lines until brackets close. */
function assignment(entry, sourceLine) {
  if (!entry?.file) return null;
  let text = sourceLine(entry.file, entry.line);
  if (text == null) return null;
  const m = new RegExp(`(?:^|[\\s/])${entry.name}\\s*=\\s*([\\s\\S]*)$`).exec(text.replace(/\/\/.*$/, ''));
  if (!m) return null;
  let value = m[1].trim();
  for (let k = 1; k <= 64; k++) {
    const opens = (value.match(/[([]/g) || []).length, closes = (value.match(/[)\]]/g) || []).length;
    if (opens <= closes && !/[,(]\s*$/.test(value) && !/\\\s*$/.test(value)) break;
    const next = sourceLine(entry.file, entry.line + k); if (next == null) break;
    value = value.replace(/\\\s*$/, '') + ' ' + next.replace(/\/\/.*$/, '').trim();
  }
  return value.replace(/;$/, '').trim();
}

/** Describe one generator type (cached per atom text by the caller). */
function describe(tree, atom, root, sourceLine, defines) {
  const chain = tree.chain(atom.path), rootAt = chain.indexOf(root);
  const names = new Set();
  for (const p of chain.slice(0, rootAt + 1)) for (const v of tree.get(p)?.vars ?? []) if (!SKIP.has(v)) names.add(v);
  const overrides = new Map(overrideAssignments(atom.overridesRaw).map(o => [o.key, o.raw]));
  for (const k of overrides.keys()) if (!SKIP.has(k)) names.add(k);
  const spawns = [], settings = {}, unresolved = [];
  for (const name of [...names].sort()) {
    const entry = tree.lookupVar(atom.path, name);
    const raw = overrides.has(name) ? overrides.get(name) : assignment(entry, sourceLine);
    if (raw == null) continue;
    const list = parseTypeList(raw, defines);
    if (list) { spawns.push({ var: name, from: overrides.has(name) ? 'map' : entry?.from ?? null, types: list.types.map(t => ({ ...t, known: tree.has(t.path) })) }); continue; }
    const v = parseValue(raw, defines);
    if (v.status === 'unresolved') { if (/[/(]/.test(raw)) unresolved.push({ var: name, raw: raw.slice(0, 200) }); continue; }
    if (raw === 'null' || raw === 'list()') continue;
    settings[name] = v.value;
  }
  const initProcs = INIT_PROCS.map(n => ({ proc: n, definedIn: tree.procOwner?.(atom.path, n) ?? null })).filter(p => p.definedIn && p.definedIn !== '/datum' && p.definedIn !== '/atom');
  return { path: atom.path, root, spawns, settings, unresolved, initProcs };
}

/**
 * Find generators in a map. Options: roots (type paths), z (one level), limit (instances listed).
 * Returns {roots, generators: [{path, root, instances, spawns, settings, unresolved, initProcs}],
 *   instances: [{x, y, z, path}], instanceCount, truncated, unknownRoots}.
 */
export function findGenerators(map, tree, sourceLine, { roots = GENERATOR_PROFILES.default.roots, z, limit = 10000, defines = new Map() } = {}) {
  if (!Array.isArray(roots) || !roots.length || !roots.every(r => TYPE_PATH.test(r))) throw new TypeError('roots must be type paths');
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100000) throw new TypeError('Invalid limit');
  const rootOf = new Map();
  const matchRoot = path => { if (!rootOf.has(path)) rootOf.set(path, tree.has(path) ? roots.find(r => tree.isA(path, r)) ?? null : null); return rootOf.get(path); };
  const perKey = new Map();
  for (const d of map.definitions) {
    const hits = d.atoms.filter(a => matchRoot(a.path));
    if (hits.length) perKey.set(d.key, hits);
  }
  const byAtom = new Map(), instances = [];
  let count = 0;
  for (const c of map.cells()) {
    if (z !== undefined && c.z !== z) continue;
    const hits = perKey.get(c.key); if (!hits) continue;
    for (const a of hits) {
      const k = a.raw.trim();
      if (!byAtom.has(k)) byAtom.set(k, { ...describe(tree, a, matchRoot(a.path), sourceLine, defines), overrides: a.overridesRaw ?? null, instances: 0 });
      byAtom.get(k).instances++; count++;
      if (instances.length < limit) instances.push({ x: c.x, y: c.y, z: c.z, path: a.path });
    }
  }
  return { roots: [...roots], unknownRoots: roots.filter(r => !tree.has(r)), instanceCount: count, truncated: count > instances.length,
    generators: [...byAtom.values()].sort((p, q) => q.instances - p.instances || p.path.localeCompare(q.path)), instances };
}

/** Outline the given tiles on a rendered image in place (cyan). Returns how many were drawn. */
export function markTiles(img, tiles, region, iconSize, color = [0, 230, 255]) {
  const t = Math.max(1, Math.round(iconSize / 16)), seen = new Set();
  for (const p of tiles) {
    if (p.z !== region.z || p.x < region.x1 || p.x > region.x2 || p.y < region.y1 || p.y > region.y2) continue;
    const k = `${p.x},${p.y}`; if (seen.has(k)) continue; seen.add(k);
    const ox = (p.x - region.x1) * iconSize, oy = (region.y2 - p.y) * iconSize;
    for (let py = 0; py < iconSize; py++) for (let px = 0; px < iconSize; px++) {
      if (px >= t && py >= t && px < iconSize - t && py < iconSize - t) continue;
      const di = ((oy + py) * img.width + ox + px) * 4; img.rgba[di] = color[0]; img.rgba[di + 1] = color[1]; img.rgba[di + 2] = color[2]; img.rgba[di + 3] = 255;
    }
  }
  return seen.size;
}

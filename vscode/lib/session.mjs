/**
 * One open map in the editor: answers summary and cell questions and renders views with the
 * static renderer when a type tree is available. `text` is the map text, or a function that
 * returns the current (possibly edited, unsaved) text. Writes nothing; edits live in mapdoc.mjs.
 * Independent of the VS Code API so it can be tested with node:test.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

/** Where the byond-devtools core lives: bundled in ./core for a .vsix, ../../src in the repo. */
export function coreDir(here) {
  for (const candidate of [path.join(here, '..', 'core'), path.join(here, '..', '..', 'src')]) if (existsSync(path.join(candidate, 'dmm.js'))) return candidate;
  throw new Error('byond-devtools core not found');
}
const load = async (dir, file) => import(pathToFileURL(path.join(dir, file)).href);

export const MAX_VIEW_TILES = 64 * 64;
// Built-in atom vars a map can override; the type tree lists only vars a project declares.
const BUILTIN_VARS = ['alpha', 'color', 'density', 'desc', 'dir', 'icon', 'icon_state', 'invisibility', 'layer', 'luminosity', 'mouse_opacity', 'name', 'opacity', 'pixel_w', 'pixel_x', 'pixel_y', 'pixel_z', 'plane', 'tag'];

export async function openSession({ text, root, mapRelative, dme, treeFile, byondBin, core }) {
  const { parseDmm } = await load(core, 'dmm.js');
  const { overrideAssignments } = await load(core, 'world.js');
  const textOf = typeof text === 'function' ? text : () => text;
  let parsedText = null, parsed = null;
  const current = () => { const t = textOf(); if (t !== parsedText) { parsed = parseDmm(t); parsedText = t; } return parsed; };
  current();
  let renderer = null, rendererError = null;
  async function ensureRenderer() {
    if (renderer || rendererError) return renderer;
    if (!dme) { rendererError = 'No .dme found or configured (byondDevtools.dme).'; return null; }
    if (!treeFile && !byondBin) { rendererError = 'Set byondDevtools.byondBin (BYOND bin folder) or byondDevtools.typeTree to render icons.'; return null; }
    try { const { loadRenderer } = await load(core, 'render-project.js'); renderer = await loadRenderer({ root, dme, treeFile, binDir: treeFile ? undefined : byondBin }); }
    catch (e) { rendererError = `Type tree failed: ${e.message}`; }
    return renderer;
  }
  return {
    get map() { return current(); },
    /** Type paths for the editor's suggestions: the project's /area, /turf, /obj and /mob types when the tree is loaded, else the map's own. */
    async typePaths() {
      const own = current().summary().types.map(t => t.path), r = await ensureRenderer();
      const tree = r ? r.tree.paths().filter(p => /^\/(area|turf|obj|mob)(\/|$)/.test(p)) : [];
      return [...new Set([...own, ...tree])].sort();
    },
    /** Paths the project's type tree does not define (none when no tree is loaded). */
    async unknownTypes(paths) {
      const r = await ensureRenderer(); if (!r) return [];
      return [...new Set(paths)].filter(p => !r.tree.has(p));
    },
    /** Var names a type can override: built-in atom vars plus, with the tree loaded, its declared and inherited ones. */
    async varsOf(type) {
      const r = await ensureRenderer(), own = r && r.tree.has(type) ? r.tree.chain(type).flatMap(p => r.tree.get(p)?.vars ?? []) : [];
      return [...new Set([...BUILTIN_VARS, ...own])].sort();
    },
    summary() {
      const s = current().summary();
      return { world: s.world, levels: s.levels, cellCount: s.cellCount, dictionaryEntries: s.dictionaryEntries, keyWidth: s.keyWidth, diagnostics: s.diagnostics, topTypes: [...s.types].sort((a, b) => b.instances - a.instances).slice(0, 20) };
    },
    inspect(x, y, z) {
      const c = current().inspectCell(x, y, z);
      return c ? { x, y, z, key: c.key, atoms: c.atoms.map(a => ({ path: a.path, overrides: a.overridesRaw, raw: a.raw.trim(), vars: overrideAssignments(a.overridesRaw).map(v => ({ key: v.key, value: v.raw })) })) } : { x, y, z, key: null, atoms: [] };
    },
    async render({ x1, y1, x2, y2, z }) {
      const map = current(), w = map.world;
      x1 = Math.max(1, x1); y1 = Math.max(1, y1); x2 = Math.min(w.maxX, x2); y2 = Math.min(w.maxY, y2);
      if (x2 < x1 || y2 < y1 || z < 1 || z > w.maxZ) throw new RangeError('View is outside the map');
      if ((x2 - x1 + 1) * (y2 - y1 + 1) > MAX_VIEW_TILES) throw new RangeError(`View is limited to ${MAX_VIEW_TILES} tiles`);
      const r = await ensureRenderer();
      if (!r) return { error: rendererError, region: { x1, y1, x2, y2, z } };
      const { renderMap } = await load(core, 'render-project.js');
      const out = await renderMap(r, { root, mapText: textOf(), x1, y1, x2, y2, z });
      return { png: Buffer.from(out.png).toString('base64'), region: { x1, y1, x2, y2, z }, iconSize: r.iconSize, width: out.result.width, height: out.result.height, drawn: out.result.drawn, diagnostics: out.result.diagnostics, truthLayer: out.result.truthLayer, mapPath: mapRelative };
    },
  };
}

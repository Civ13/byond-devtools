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
export const ANIMATION_FRAMES = 8, ANIMATION_INTERVAL_MS = 200;
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
    /**
     * Tiles that differ from the map at git revision `ref` (read-only git show of the saved
     * file's path): {ref, changedCells, levels, cells (at most limit, map order), truncated}.
     */
    async changes({ ref = 'HEAD', limit = 500 } = {}) {
      const { gitShow } = await load(core, 'diff-project.js'), { diffMaps } = await load(core, 'diff.js');
      const before = parseDmm(gitShow(root, mapRelative, ref));
      const d = diffMaps(before, current(), { limit });
      return { ref, changedCells: d.changedCells, truncated: d.truncated, levels: d.levels, world: d.world,
        cells: d.cells.map(c => ({ x: c.x, y: c.y, z: c.z, change: c.change, removed: c.removed.length, added: c.added.length })) };
    },
    /**
     * Render a view against git revision `ref`: the current map with unchanged tiles dimmed
     * and changed tiles outlined (yellow modified, blue reordered, green added, red removed).
     * Same region and tile grid as render(), so tiles can still be clicked.
     */
    async compare({ x1, y1, x2, y2, z, ref = 'HEAD' }) {
      const map = current(), w = map.world;
      x1 = Math.max(1, x1); y1 = Math.max(1, y1); x2 = Math.min(w.maxX, x2); y2 = Math.min(w.maxY, y2);
      if (x2 < x1 || y2 < y1 || z < 1 || z > w.maxZ) throw new RangeError('View is outside the map');
      if ((x2 - x1 + 1) * (y2 - y1 + 1) > MAX_VIEW_TILES) throw new RangeError(`View is limited to ${MAX_VIEW_TILES} tiles`);
      const r = await ensureRenderer();
      if (!r) return { error: rendererError, region: { x1, y1, x2, y2, z } };
      const { gitShow } = await load(core, 'diff-project.js'), { regionChanges, composeDiff } = await load(core, 'diff.js');
      const { renderMap } = await load(core, 'render-project.js'), { encodePng } = await load(core, 'png.js');
      const beforeText = gitShow(root, mapRelative, ref), region = { x1, y1, x2, y2, z };
      const beforeMap = parseDmm(beforeText);
      if (z > beforeMap.world.maxZ) throw new RangeError(`Level ${z} does not exist at ${ref}`);
      const b = await renderMap(r, { root, mapText: beforeText, ...region }), a = await renderMap(r, { root, mapText: textOf(), ...region });
      const changes = regionChanges(beforeMap, map, region), gap = 4;
      const full = composeDiff(b.result, a.result, changes, region, r.iconSize, { gap });
      // Keep only the highlight panel (the third), so the picture lines up with the tile grid.
      const pw = a.result.width, ph = a.result.height, ox = (pw + gap) * 2, rgba = new Uint8Array(pw * ph * 4);
      for (let y = 0; y < ph; y++) rgba.set(full.rgba.subarray((y * full.width + ox) * 4, (y * full.width + ox + pw) * 4), y * pw * 4);
      const png = encodePng({ width: pw, height: ph, rgba }, { text: { Comment: `byond-devtools map compare with ${ref}: changed tiles outlined` } });
      return { png: Buffer.from(png).toString('base64'), region, iconSize: r.iconSize, width: pw, height: ph, drawn: a.result.drawn,
        diagnostics: a.result.diagnostics, truthLayer: a.result.truthLayer, mapPath: mapRelative, compare: { ref, changedTiles: changes.length } };
    },
    /** 1-based line of a dictionary key's definition in the current text, or null. */
    keyLine(key) {
      if (typeof key !== 'string' || !/^[A-Za-z]+$/.test(key)) return null;
      const t = textOf(), at = t.search(new RegExp(`^"${key}" = \\(`, 'm'));
      return at < 0 ? null : t.slice(0, at).split('\n').length;
    },
    /**
     * Render a view. Options: kinds (atom kinds to draw; default turf, obj, mob), focus (a type
     * path: everything else is dimmed), animate (an animated PNG of ANIMATION_FRAMES frames,
     * every animated icon state stepping by its own delays).
     */
    async render({ x1, y1, x2, y2, z, kinds, focus, animate = false }) {
      const map = current(), w = map.world;
      x1 = Math.max(1, x1); y1 = Math.max(1, y1); x2 = Math.min(w.maxX, x2); y2 = Math.min(w.maxY, y2);
      if (x2 < x1 || y2 < y1 || z < 1 || z > w.maxZ) throw new RangeError('View is outside the map');
      if ((x2 - x1 + 1) * (y2 - y1 + 1) > MAX_VIEW_TILES) throw new RangeError(`View is limited to ${MAX_VIEW_TILES} tiles`);
      const r = await ensureRenderer();
      if (!r) return { error: rendererError, region: { x1, y1, x2, y2, z } };
      const { renderMap } = await load(core, 'render-project.js');
      const shownKinds = Array.isArray(kinds) ? kinds.filter(k => ['area', 'turf', 'obj', 'mob'].includes(k)) : ['turf', 'obj', 'mob'];
      const focusType = typeof focus === 'string' && focus.trim() ? focus.trim().replace(/\/+$/, '') : null;
      const allDefault = shownKinds.length === 3 && !shownKinds.includes('area');
      const filter = allDefault && !focusType ? null : { kinds: shownKinds, focus: focusType ? [focusType] : undefined, mode: 'hide' };
      const options = { root, mapText: textOf(), x1, y1, x2, y2, z, areas: shownKinds.includes('area'), filter };
      const out = await renderMap(r, options);
      let png = out.png, animation = null;
      if (animate) {
        const { encodeApng } = await load(core, 'png.js');
        const frames = [out.result.rgba];
        for (let i = 1; i < ANIMATION_FRAMES; i++) frames.push((await renderMap(r, { ...options, timeDs: (i * ANIMATION_INTERVAL_MS) / 100 })).result.rgba);
        png = encodeApng(frames, { width: out.result.width, height: out.result.height, delaysMs: frames.map(() => ANIMATION_INTERVAL_MS) });
        animation = { frames: ANIMATION_FRAMES, intervalMs: ANIMATION_INTERVAL_MS };
      }
      return { png: Buffer.from(png).toString('base64'), region: { x1, y1, x2, y2, z }, iconSize: r.iconSize, width: out.result.width, height: out.result.height, drawn: out.result.drawn, diagnostics: out.result.diagnostics, truthLayer: out.result.truthLayer, mapPath: mapRelative, animation, focus: focusType };
    },
  };
}

/**
 * One open map in the viewer. Read-only: parses the map text, answers summary and cell
 * questions, and renders views with the static renderer when a type tree is available.
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

export async function openSession({ text, root, mapRelative, dme, treeFile, byondBin, core }) {
  const { parseDmm } = await load(core, 'dmm.js');
  const map = parseDmm(text);
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
    map,
    summary() {
      const s = map.summary();
      return { world: s.world, levels: s.levels, cellCount: s.cellCount, dictionaryEntries: s.dictionaryEntries, keyWidth: s.keyWidth, diagnostics: s.diagnostics, topTypes: [...s.types].sort((a, b) => b.instances - a.instances).slice(0, 20) };
    },
    inspect(x, y, z) {
      const c = map.inspectCell(x, y, z);
      return c ? { x, y, z, key: c.key, atoms: c.atoms.map(a => ({ path: a.path, overrides: a.overridesRaw })) } : { x, y, z, key: null, atoms: [] };
    },
    async render({ x1, y1, x2, y2, z }) {
      const w = map.world;
      x1 = Math.max(1, x1); y1 = Math.max(1, y1); x2 = Math.min(w.maxX, x2); y2 = Math.min(w.maxY, y2);
      if (x2 < x1 || y2 < y1 || z < 1 || z > w.maxZ) throw new RangeError('View is outside the map');
      if ((x2 - x1 + 1) * (y2 - y1 + 1) > MAX_VIEW_TILES) throw new RangeError(`View is limited to ${MAX_VIEW_TILES} tiles`);
      const r = await ensureRenderer();
      if (!r) return { error: rendererError, region: { x1, y1, x2, y2, z } };
      const { renderMap } = await load(core, 'render-project.js');
      const out = await renderMap(r, { root, mapText: text, x1, y1, x2, y2, z });
      return { png: Buffer.from(out.png).toString('base64'), region: { x1, y1, x2, y2, z }, iconSize: r.iconSize, width: out.result.width, height: out.result.height, diagnostics: out.result.diagnostics, truthLayer: out.result.truthLayer, mapPath: mapRelative };
    },
  };
}

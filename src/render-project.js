/**
 * I/O side of the static renderer: loads a project's type tree, the map and every icon the
 * region needs (project-contained reads only), then calls the pure renderRegion.
 */
import path from 'node:path';
import { readProjectBytes, readProjectFile, loadProjectTypes } from './project.js';
import { parseTypeTree, resolveVar, collectDefines } from './typetree.js';
import { parseDmm } from './dmm.js';
import { decodeDmi } from './dmi.js';
import { encodePng } from './png.js';
import { appearanceResolver, renderRegion } from './render.js';

/** Load everything needed to render maps of one project. */
export async function loadRenderer({ root, dme, binDir, treeFile }) {
  const project = await loadProjectTypes({ root, dme, binDir, treeFile });
  const tree = parseTypeTree(project.xml), defines = collectDefines(project.defineSources);
  await project.preload([...new Set([...project.xml.matchAll(/file="([^":]+):\d+"/g)].map(m => m[1]))]);
  const appearance = appearanceResolver(tree, project.sourceLine, defines, resolveVar);
  const size = resolveVar(tree.lookupVar('/world', 'icon_size'), project.sourceLine, defines);
  const iconSize = typeof size.value === 'number' && Number.isInteger(size.value) && size.value > 0 ? size.value : 32;
  const icons = new Map(), base = path.posix.dirname(dme.replaceAll('\\', '/'));
  async function loadIcon(file) {
    if (icons.has(file)) return;
    let found = null;
    // Resource paths resolve against the .dme folder (FILE_DIR); a project-root path is the fallback.
    for (const candidate of [...new Set([path.posix.join(base, file), file])]) {
      try { const input = await readProjectBytes(root, candidate); found = { dmi: decodeDmi(input.data), file: candidate, sha256: input.sha256 }; break; }
      catch { /* not here, unreadable or not a DMI */ }
    }
    icons.set(file, found);
  }
  return { project, tree, defines, appearance, iconSize, icons, loadIcon };
}

/**
 * Render a region of a project map. Returns {png, result, provenance}. Options are those of
 * renderRegion plus `map` (project-relative) or `mapText`.
 */
export async function renderMap(renderer, { root, map, mapText, ...region }) {
  const input = mapText !== undefined ? { text: mapText, sha256: null } : await readProjectFile(root, map);
  const parsed = parseDmm(input.text);
  const z = region.z ?? 1;
  const x1 = region.x1 ?? 1, y1 = region.y1 ?? 1, x2 = region.x2 ?? parsed.world.maxX, y2 = region.y2 ?? parsed.world.maxY;
  if (z > parsed.world.maxZ) throw new RangeError(`Map has ${parsed.world.maxZ} z-levels`);
  const tiles = (Math.max(0, x2 - x1) + 1) * (Math.max(0, y2 - y1) + 1);
  if (tiles > (region.maxTiles ?? 128 * 128)) throw new RangeError(`Region of ${tiles} tiles exceeds the ${region.maxTiles ?? 128 * 128}-tile limit`);
  // Resolve appearances once to learn which icon files the region needs, then load them.
  const needed = new Set();
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) for (const a of parsed.inspectCell(x, y, z)?.atoms ?? []) {
    const ap = renderer.appearance(a); if (ap.icon && typeof ap.icon === 'object' && ap.icon.resource) needed.add(ap.icon.resource);
  }
  for (const f of [...needed].sort()) await renderer.loadIcon(f);
  const result = renderRegion(parsed, { iconSize: renderer.iconSize, ...region, x1, y1, x2, y2, z, appearance: renderer.appearance, icon: f => renderer.icons.get(f)?.dmi ?? null });
  const provenance = { map: map ?? null, sha256: input.sha256, dme: renderer.project.dme, region: { x1, y1, x2, y2, z }, iconSize: region.iconSize ?? renderer.iconSize, truthLayer: result.truthLayer,
    icons: [...needed].sort().map(f => ({ resource: f, file: renderer.icons.get(f)?.file ?? null, sha256: renderer.icons.get(f)?.sha256 ?? null })) };
  const png = encodePng(result, { text: { Comment: `byond-devtools static render; ${result.truthLayer}; not a client screenshot` } });
  return { png, result, provenance };
}

/**
 * Static map preview: draws the authored map with icons from the native type tree.
 * Pure: the caller supplies `appearance(atom)` and `icon(path)` lookups; no I/O here.
 *
 * Truth layer: authored source + compiled type defaults. It is NOT a client screenshot.
 * Not modelled: New()/Initialize() changes, smoothing/overlays added at runtime, lighting,
 * filters, transforms, planes' render relays, see_invisible. Animated states show frame 1, or the
 * frame due at `timeDs` deciseconds when that is given (all animations started together).
 * Every atom that cannot be drawn exactly is counted in `diagnostics`, never silently skipped.
 */
import { overrideAssignments } from './world.js';
import { parseValue } from './typetree.js';
import { frameAt } from './dmi.js';

export const RENDER_VARS = Object.freeze(['icon', 'icon_state', 'dir', 'layer', 'plane', 'pixel_x', 'pixel_y', 'pixel_w', 'pixel_z', 'color', 'alpha', 'invisibility']);
const DEFAULTS = Object.freeze({ icon: null, icon_state: '', dir: 2, layer: null, plane: 0, pixel_x: 0, pixel_y: 0, pixel_w: 0, pixel_z: 0, color: null, alpha: 255, invisibility: 0 });
const KIND_LAYER = { area: 1, turf: 2, obj: 3, mob: 4 };
const kindOf = p => p.startsWith('/area') ? 'area' : p.startsWith('/turf') ? 'turf' : p.startsWith('/mob') ? 'mob' : 'obj';

/**
 * Build an appearance resolver from a type tree. Map overrides are applied when they are
 * plain values; an override the resolver cannot evaluate marks the atom `approximate`.
 */
export function appearanceResolver(tree, sourceLine, defines, resolveVar) {
  const typeCache = new Map();
  function typeAppearance(path) {
    if (typeCache.has(path)) return typeCache.get(path);
    const out = { ...DEFAULTS, layer: KIND_LAYER[kindOf(path)], unresolved: [] };
    for (const v of RENDER_VARS) {
      const r = resolveVar(tree.lookupVar(path, v), sourceLine, defines);
      if (r.status === 'unset') continue;
      if (r.status === 'unresolved') { out.unresolved.push(v); continue; }
      out[v] = r.value;
    }
    typeCache.set(path, out); return out;
  }
  return function appearance(atom) {
    if (!tree.has(atom.path)) return { unknownType: true };
    const a = { ...typeAppearance(atom.path) }; a.unresolved = [...a.unresolved];
    for (const o of overrideAssignments(atom.overridesRaw)) {
      if (!RENDER_VARS.includes(o.key)) continue;
      const r = parseValue(o.raw, defines);
      if (r.status === 'unresolved') { a.unresolved.push(o.key); continue; }
      a[o.key] = r.value; a.unresolved = a.unresolved.filter(k => k !== o.key);
    }
    return a;
  };
}

function parseColor(value) {
  if (value == null) return null;
  const m = typeof value === 'string' && /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (!m) return undefined; // matrices, names and lists are not modelled
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) : 255];
}

/**
 * Render tiles x1..x2, y1..y2 on level z. Returns {width, height, rgba, diagnostics, drawn}.
 * Limits: at most `maxTiles` tiles and `maxPixels` output pixels.
 */
export function renderRegion(map, { x1, y1, x2, y2, z, iconSize = 32, appearance, icon, areas = false, showInvisible = false, grid = 0,
  filter = null, timeDs = null, maxTiles = 128 * 128, maxPixels = 16 * 1024 * 1024 }) {
  const keep = atomFilter(filter);
  for (const v of [x1, y1, x2, y2, z]) if (!Number.isSafeInteger(v) || v < 1) throw new TypeError('Region coordinates must be positive integers');
  if (x2 < x1 || y2 < y1) throw new RangeError('Empty region');
  const tilesW = x2 - x1 + 1, tilesH = y2 - y1 + 1;
  if (tilesW * tilesH > maxTiles) throw new RangeError(`Region of ${tilesW * tilesH} tiles exceeds the ${maxTiles}-tile limit`);
  const width = tilesW * iconSize, height = tilesH * iconSize;
  if (width * height > maxPixels) throw new RangeError('Output pixel limit exceeded');
  const rgba = new Uint8Array(width * height * 4);
  const counts = new Map(), bump = (code, detail) => { const k = `${code}\u0000${detail}`; counts.set(k, (counts.get(k) || 0) + 1); };
  let drawn = 0, holes = 0;
  const sprites = [];
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
    const cell = map.inspectCell(x, y, z);
    if (!cell) { holes++; continue; }
    // Native contents order: turfs (underlays first), then objs, then mobs; areas below all.
    const atoms = cell.atoms.map((a, i) => ({ a, i, kind: kindOf(a.path) }));
    const order = [...atoms.filter(t => t.kind === 'area'), ...atoms.filter(t => t.kind === 'turf'), ...atoms.filter(t => t.kind === 'obj'), ...atoms.filter(t => t.kind === 'mob')];
    order.forEach(({ a, kind }, stack) => {
      if (kind === 'area' && !areas) return;
      const shown = keep(a.path, kind);
      if (shown === 'hide') { bump('filtered-out', a.path); return; }
      const ap = appearance(a);
      if (ap.unknownType) { bump('unknown-type', a.path); sprites.push({ x, y, plane: 0, layer: KIND_LAYER[kind], stack, placeholder: true }); return; }
      if (!showInvisible && typeof ap.invisibility === 'number' && ap.invisibility > 0) { bump('invisible-skipped', a.path); return; }
      for (const v of ap.unresolved) bump('approximate-var', `${a.path}.${v}`);
      if (ap.icon == null) return; // no icon: nothing to draw, as in game
      sprites.push({ x, y, plane: typeof ap.plane === 'number' ? ap.plane : 0, layer: typeof ap.layer === 'number' ? ap.layer : KIND_LAYER[kind], stack, ap, path: a.path, dim: shown === 'dim' });
    });
  }
  // Draw order: plane, then layer, then position in the tile's stack, then south rows over north.
  sprites.sort((p, q) => p.plane - q.plane || p.layer - q.layer || q.y - p.y || p.stack - q.stack || p.x - q.x);
  for (const s of sprites) {
    const baseX = (s.x - x1) * iconSize, baseY = (y2 - s.y) * iconSize; // top-left of the tile in the image
    if (s.placeholder) { drawPlaceholder(rgba, width, height, baseX, baseY, iconSize); continue; }
    const ap = s.ap, file = ap.icon && typeof ap.icon === 'object' ? ap.icon.resource : null;
    const dmi = file ? icon(file) : null;
    if (!dmi) { bump('missing-icon', file ?? String(ap.icon)); drawPlaceholder(rgba, width, height, baseX, baseY, iconSize); continue; }
    const state = dmi.findState(String(ap.icon_state ?? ''));
    if (!state) { bump('missing-state', `${file}:${ap.icon_state}`); continue; } // BYOND draws nothing for a missing state
    const pixels = dmi.frame(state, typeof ap.dir === 'number' ? ap.dir : 2, timeDs == null ? 1 : frameAt(state, timeDs), { display: true });
    const tint = parseColor(ap.color);
    if (tint === undefined) bump('approximate-var', `${s.path}.color`);
    let alpha = typeof ap.alpha === 'number' ? Math.max(0, Math.min(255, Math.trunc(ap.alpha))) : 255; // builtin alpha stores an integer
    if (s.dim) alpha = Math.round(alpha * 0.25);
    const ox = baseX + (Number(ap.pixel_x) || 0) + (Number(ap.pixel_w) || 0);
    const oy = baseY + iconSize - dmi.height - (Number(ap.pixel_y) || 0) - (Number(ap.pixel_z) || 0); // icons anchor bottom-left
    blit(rgba, width, height, pixels, dmi.width, dmi.height, ox, oy, tint || null, alpha);
    drawn++;
  }
  if (grid > 0) drawGrid(rgba, width, height, x1, y2, iconSize, grid);
  const diagnostics = [...counts].map(([k, n]) => { const [code, detail] = k.split('\u0000'); return { code, detail, count: n }; })
    .sort((p, q) => p.code.localeCompare(q.code) || q.count - p.count || p.detail.localeCompare(q.detail));
  return { width, height, rgba, drawn, holes, diagnostics, truthLayer: 'authored-source+type-defaults' };
}

/**
 * Atom filter for renderRegion. filter: {kinds, excludeKinds, types, excludeTypes, focus, mode}.
 * types match a path or any subtype. Returns (path, kind) -> 'show' | 'dim' | 'hide'.
 */
export function atomFilter(filter) {
  if (!filter) return () => 'show';
  const under = (path, roots) => roots.some(r => path === r || path.startsWith(r.endsWith('/') ? r : r + '/'));
  const { kinds, excludeKinds, types, excludeTypes, focus, mode = 'hide' } = filter;
  if (mode !== 'hide' && mode !== 'dim') throw new TypeError('filter mode must be hide or dim');
  return (path, kind) => {
    const ok = (!kinds?.length || kinds.includes(kind)) && !excludeKinds?.includes(kind)
      && (!types?.length || under(path, types)) && !(excludeTypes?.length && under(path, excludeTypes));
    if (!ok) return mode;
    // focus: atoms the other filters keep are dimmed unless they are (under) one of these types.
    return focus?.length && !under(path, focus) ? 'dim' : 'show';
  };
}

function blit(dst, dw, dh, src, sw, sh, ox, oy, tint, alpha) {
  for (let y = 0; y < sh; y++) {
    const ty = oy + y; if (ty < 0 || ty >= dh) continue;
    for (let x = 0; x < sw; x++) {
      const tx = ox + x; if (tx < 0 || tx >= dw) continue;
      const si = (y * sw + x) * 4; let a = src[si + 3]; if (!a) continue;
      let r = src[si], g = src[si + 1], b = src[si + 2];
      if (tint) { r = (r * tint[0]) / 255; g = (g * tint[1]) / 255; b = (b * tint[2]) / 255; a = (a * tint[3]) / 255; }
      a = (a * alpha) / 255;
      const di = (ty * dw + tx) * 4, da = dst[di + 3] / 255, sa = a / 255, oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      dst[di] = Math.round((r * sa + dst[di] * da * (1 - sa)) / oa);
      dst[di + 1] = Math.round((g * sa + dst[di + 1] * da * (1 - sa)) / oa);
      dst[di + 2] = Math.round((b * sa + dst[di + 2] * da * (1 - sa)) / oa);
      dst[di + 3] = Math.round(oa * 255);
    }
  }
}

/** Magenta/black checkerboard: impossible to mistake for real art. */
function drawPlaceholder(dst, dw, dh, ox, oy, size) {
  const cell = Math.max(1, size >> 2);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const tx = ox + x, ty = oy + y; if (tx < 0 || ty < 0 || tx >= dw || ty >= dh) continue;
    const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0, di = (ty * dw + tx) * 4;
    dst[di] = on ? 255 : 0; dst[di + 1] = 0; dst[di + 2] = on ? 255 : 0; dst[di + 3] = 255;
  }
}

// 3x5 digits for coordinate labels.
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
function drawText(dst, dw, dh, text, ox, oy) {
  [...text].forEach((ch, i) => {
    const glyph = DIGITS[ch.charCodeAt(0) - 48]; if (!glyph) return;
    for (let gy = -1; gy <= 5; gy++) for (let gx = -1; gx <= 3; gx++) {
      const tx = ox + i * 4 + gx, ty = oy + gy; if (tx < 0 || ty < 0 || tx >= dw || ty >= dh) continue;
      const on = gx >= 0 && gx < 3 && gy >= 0 && gy < 5 && glyph[gy * 3 + gx] === '1', di = (ty * dw + tx) * 4;
      const v = on ? 255 : 0; dst[di] = v; dst[di + 1] = v; dst[di + 2] = 0; dst[di + 3] = 255; // yellow on black
    }
  });
}
function drawGrid(dst, dw, dh, x1, yTop, size, every) {
  for (let tx = 0; tx * size < dw; tx++) for (let ty = 0; ty * size < dh; ty++) {
    const wx = x1 + tx, wy = yTop - ty;
    if (wx % every !== 0 && wy % every !== 0) continue;
    if (wx % every === 0) for (let y = 0; y < size; y++) { const di = ((ty * size + y) * dw + tx * size) * 4; dst[di] = 255; dst[di + 1] = 255; dst[di + 2] = 0; dst[di + 3] = 255; }
    if (wy % every === 0) for (let x = 0; x < size; x++) { const di = (((ty + 1) * size - 1) * dw + tx * size + x) * 4; dst[di] = 255; dst[di + 1] = 255; dst[di + 2] = 0; dst[di + 3] = 255; }
    // x above y in the tile's top-left corner (the font has digits only).
    if (wx % every === 0 && wy % every === 0) { drawText(dst, dw, dh, String(wx), tx * size + 2, ty * size + 2); drawText(dst, dw, dh, String(wy), tx * size + 2, ty * size + 9); }
  }
}

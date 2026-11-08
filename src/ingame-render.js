/**
 * Render an in-game dump (src/ingame.js) the way a BYOND client composes a TOPDOWN map:
 * appearance trees (overlays and underlays with inherited dir, colour, alpha, offsets and
 * transform), colour matrices, blend modes, planes and plane masters, see_invisible.
 * Pure: the caller passes decoded icons. Works in premultiplied float RGBA.
 *
 * Screen objects (dump.screen: [appearance, screen_loc] pairs from client.screen, with
 * dump.view as the client's view size) are placed by screen_loc around the dump's centre and
 * sorted into the same planes as the map. The result also lists `undrawn`: visible, clickable
 * movables whose whole appearance tree put no pixel on the map (an atom a player can interact
 * with but cannot see).
 *
 * Not modelled (counted in diagnostics): filters, maptext, vis_contents, animation past
 * frame 1, KEEP_TOGETHER groups, secondary-map screen objects and client.color.
 */
const FLOAT_LAYER = -1, FLOAT_PLANE = -32767;
const RESET_COLOR = 2, RESET_ALPHA = 4, RESET_TRANSFORM = 8, KEEP_TOGETHER = 32;
const BLEND = { 0: 'default', 1: 'overlay', 2: 'add', 3: 'subtract', 4: 'multiply', 5: 'inset' };
const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0]);

/**
 * BYOND colour (hex text or list) as a 20-entry matrix: out_j = sum_i in_i * m[i*4+j] + m[16+j].
 * Returns null for "no colour", undefined when the value is not understood.
 */
export function colorMatrix(color) {
  if (color == null || color === '') return null;
  if (typeof color === 'string') {
    const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color) || /^#([0-9a-f]{3})$/i.exec(color);
    if (!m) return undefined;
    const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
    const n = parseInt(hex, 16), a = m[2] ? parseInt(m[2], 16) / 255 : 1;
    return [((n >> 16) & 255) / 255, 0, 0, 0, 0, ((n >> 8) & 255) / 255, 0, 0, 0, 0, (n & 255) / 255, 0, 0, 0, 0, a, 0, 0, 0, 0];
  }
  if (!Array.isArray(color) || !color.every(v => typeof v === 'number')) return undefined;
  const out = [...IDENTITY], c = color;
  if (c.length === 9 || c.length === 12) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 4 + j] = c[i * 3 + j];
    if (c.length === 12) for (let j = 0; j < 3; j++) out[16 + j] = c[9 + j];
    return out;
  }
  if (c.length === 16 || c.length === 20) { for (let k = 0; k < c.length; k++) out[k] = c[k]; return out; }
  return undefined;
}
/** Matrix applying `first` then `second`. */
export function composeMatrix(first, second) {
  if (!first) return second; if (!second) return first;
  const out = new Array(20).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += first[i * 4 + k] * second[k * 4 + j]; out[i * 4 + j] = s; }
  for (let j = 0; j < 4; j++) { let s = second[16 + j]; for (let k = 0; k < 4; k++) s += first[16 + k] * second[k * 4 + j]; out[16 + j] = s; }
  return out;
}
const clamp = v => v < 0 ? 0 : v > 1 ? 1 : v;
/** Apply a matrix to straight RGBA in 0..1. */
function applyMatrix(m, r, g, b, a) {
  return [clamp(r * m[0] + g * m[4] + b * m[8] + a * m[12] + m[16]), clamp(r * m[1] + g * m[5] + b * m[9] + a * m[13] + m[17]),
    clamp(r * m[2] + g * m[6] + b * m[10] + a * m[14] + m[18]), clamp(r * m[3] + g * m[7] + b * m[11] + a * m[15] + m[19])];
}
/** Affine transform [a,b,c,d,e,f]: x' = a x + b y + c, y' = d x + e y + f (BYOND order, y up). */
const composeTransform = (inner, outer) => !inner ? outer : !outer ? inner : [
  outer[0] * inner[0] + outer[1] * inner[3], outer[0] * inner[1] + outer[1] * inner[4], outer[0] * inner[2] + outer[1] * inner[5] + outer[2],
  outer[3] * inner[0] + outer[4] * inner[3], outer[3] * inner[1] + outer[4] * inner[4], outer[3] * inner[2] + outer[4] * inner[5] + outer[5]];

/** Blend one premultiplied source pixel into a premultiplied destination buffer. */
function blendPixel(dst, i, sr, sg, sb, sa, mode) {
  const dr = dst[i], dg = dst[i + 1], db = dst[i + 2], da = dst[i + 3];
  switch (mode) {
    case 'add': dst[i] = Math.min(1, dr + sr); dst[i + 1] = Math.min(1, dg + sg); dst[i + 2] = Math.min(1, db + sb); dst[i + 3] = Math.min(1, da + sa * (1 - da)); return;
    case 'subtract': dst[i] = Math.max(0, dr - sr); dst[i + 1] = Math.max(0, dg - sg); dst[i + 2] = Math.max(0, db - sb); dst[i + 3] = Math.min(1, da + sa * (1 - da)); return;
    case 'multiply': // separable multiply with alpha: cs(1-ab) + cb(1-as) + cs*cb
      dst[i] = sr * (1 - da) + dr * (1 - sa) + sr * dr; dst[i + 1] = sg * (1 - da) + dg * (1 - sa) + sg * dg; dst[i + 2] = sb * (1 - da) + db * (1 - sa) + sb * db;
      dst[i + 3] = sa + da * (1 - sa); return;
    case 'inset': if (!da) return; // only where something is already drawn
    // falls through
    default: dst[i] = sr + dr * (1 - sa); dst[i + 1] = sg + dg * (1 - sa); dst[i + 2] = sb + db * (1 - sa); dst[i + 3] = sa + da * (1 - sa);
  }
}

/**
 * dump: from recordIngame. icons: array (by dump icon index - 1) of decoded DMIs or null.
 * Returns {width, height, rgba (Uint8Array), drawn, diagnostics, truthLayer}.
 */
const DIR_KEYS = { WEST: ['x', 'min'], LEFT: ['x', 'min'], EAST: ['x', 'max'], RIGHT: ['x', 'max'], SOUTH: ['y', 'min'], BOTTOM: ['y', 'min'], NORTH: ['y', 'max'], TOP: ['y', 'max'] };
const MAX_SCREEN_TILES = 2048;

/** A client's view size [width, height] in tiles from client.view (a radius number or "WxH"). */
export function viewSize(view, fallback = [15, 15]) {
  if (Number.isFinite(view) && view >= 0) return [2 * Math.floor(view) + 1, 2 * Math.floor(view) + 1];
  const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(String(view ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : fallback;
}

/**
 * Tiles a screen_loc covers on a view of [w, h] tiles: [{tx, ty, px, py}] with tx, ty 1-based
 * from the bottom left. Understands numbers, WEST/EAST/NORTH/SOUTH/CENTER (and LEFT/RIGHT/TOP/
 * BOTTOM) with +N/-N, :pixel offsets, either axis order for direction words and "a to b" ranges.
 * Returns null for what it cannot place (secondary maps, unknown words).
 */
export function parseScreenLoc(loc, [w, h], iconSize = 32) {
  if (typeof loc !== 'string' || !loc.trim()) return null;
  const part = text => {
    const pieces = text.trim().split(/\s+to\s+/i);
    if (pieces.length > 2) return null;
    const corners = pieces.map(corner => {
      const xy = corner.split(',');
      if (xy.length !== 2) return null;
      let [a, b] = xy.map(v => v.trim());
      const word = v => DIR_KEYS[(/^([A-Z]+)/.exec(v) || [])[1]]?.[0];
      if (word(a) === 'y' || word(b) === 'x') [a, b] = [b, a];
      const axis = (v, size, name) => {
        const m = /^(?:([A-Z]+)|(-?\d+(?:\.\d+)?))\s*([+-]\s*\d+(?:\.\d+)?)?\s*(?::\s*(-?\d+))?$/.exec(v);
        if (!m) return null;
        let t;
        if (m[1]) {
          if (m[1] === 'CENTER') t = (size + 1) / 2;
          else { const k = DIR_KEYS[m[1]]; if (!k || k[0] !== name) return null; t = k[1] === 'min' ? 1 : size; }
        } else t = Number(m[2]);
        if (m[3]) t += Number(m[3].replace(/\s+/g, ''));
        const whole = Math.floor(t);
        return { t: whole, p: Math.round((t - whole) * iconSize) + (m[4] ? Number(m[4]) : 0) };
      };
      const x = axis(a, w, 'x'), y = axis(b, h, 'y');
      return x && y ? { x, y } : null;
    });
    if (corners.some(c => !c)) return null;
    const [c1, c2 = c1] = corners, out = [];
    for (let ty = Math.min(c1.y.t, c2.y.t); ty <= Math.max(c1.y.t, c2.y.t); ty++) for (let tx = Math.min(c1.x.t, c2.x.t); tx <= Math.max(c1.x.t, c2.x.t); tx++) {
      out.push({ tx, ty, px: c1.x.p, py: c1.y.p });
      if (out.length > MAX_SCREEN_TILES) return out;
    }
    return out;
  };
  if (/^[A-Za-z_][\w]*:(?![-\d\s])/.test(loc.trim()) && !/^(WEST|EAST|NORTH|SOUTH|CENTER|LEFT|RIGHT|TOP|BOTTOM)/.test(loc.trim())) return null; // secondary map
  const all = [];
  for (const piece of loc.split(/\s*;\s*/)) { if (!piece.trim()) continue; const r = part(piece); if (!r) return null; all.push(...r); }
  return all;
}

export function renderIngame(dump, icons, { maxPixels = 16 * 1024 * 1024 } = {}) {
  const [x1, y1, x2, y2] = dump.region, size = dump.icon_size;
  const width = (x2 - x1 + 1) * size, height = (y2 - y1 + 1) * size;
  if (width * height > maxPixels) throw new RangeError('Output pixel limit exceeded');
  const counts = new Map(), bump = (code, detail) => { const k = `${code}\u0000${detail}`; counts.set(k, (counts.get(k) || 0) + 1); };
  if (dump.map_format && dump.map_format !== 0) bump('unsupported-map-format', String(dump.map_format));
  if (dump.vis_contents) bump('not-modelled', `vis_contents on ${dump.vis_contents} atoms`);
  const apps = dump.appearances, see = dump.see_invisible ?? 0;
  const sprites = [];
  let order = 0;
  // Walk one appearance tree. `key` orders sprites of one atom: underlays, self, overlays.
  function expand(id, parent, ctx) {
    const a = apps[id - 1];
    if (!a) { bump('missing-appearance', String(id)); return; }
    const flags = a.appearance_flags || 0;
    const plane = parent && a.plane === FLOAT_PLANE ? parent.plane : a.plane;
    const layer = parent && a.layer < 0 ? parent.layer : a.layer;
    const own = colorMatrix(a.color);
    if (own === undefined) bump('approximate-color', JSON.stringify(a.color).slice(0, 80));
    const alphaM = a.alpha !== 255 && a.alpha != null ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, a.alpha / 255, 0, 0, 0, 0] : null;
    const mine = composeMatrix(own || null, alphaM);
    const node = {
      plane, layer, dir: parent ? parent.dir : a.dir,
      matrix: parent && !(flags & RESET_COLOR) ? composeMatrix(mine, parent.matrix) : mine,
      px: (parent ? parent.px : ctx.px) + (a.pixel_x || 0) + (a.pixel_w || 0),
      py: (parent ? parent.py : ctx.py) + (a.pixel_y || 0) + (a.pixel_z || 0),
      transform: parent && !(flags & RESET_TRANSFORM) ? composeTransform(a.transform || null, parent.transform) : (a.transform || null),
      blend: a.blend_mode ? BLEND[a.blend_mode] ?? 'overlay' : parent ? parent.blend : 'overlay',
    };
    if (parent && (flags & RESET_ALPHA)) bump('approximate-flag', 'RESET_ALPHA');
    if (a.filters) bump('not-modelled', 'filters');
    if (a.maptext) bump('not-modelled', 'maptext');
    if (flags & KEEP_TOGETHER && (a.overlays.length || a.underlays.length)) bump('approximate-flag', 'KEEP_TOGETHER');
    a.underlays.forEach(u => expand(u, node, ctx));
    if (a.icon) sprites.push({ ...node, icon: a.icon, state: a.icon_state, x: ctx.x, y: ctx.y, atom: ctx.atom, seq: order++ });
    a.overlays.forEach(o => expand(o, node, ctx));
  }
  let atomIndex = 0;
  const atoms = []; // per atom index: null, or a movable {x, y, type, clickable} watched for undrawn
  for (const [x, y, area, turf, movables] of dump.cells) {
    const base = { x, y, px: 0, py: 0 };
    const visible = id => (apps[id - 1]?.invisibility ?? 0) <= see;
    if (visible(area)) { atoms.push(null); expand(area, null, { ...base, atom: atomIndex++ }); }
    if (visible(turf)) { atoms.push(null); expand(turf, null, { ...base, atom: atomIndex++ }); }
    for (const [id, sx, sy, type] of movables) if (visible(id)) {
      atoms.push({ x, y, type: type ?? null, clickable: (apps[id - 1]?.mouse_opacity ?? 1) !== 0 });
      expand(id, null, { ...base, px: sx || 0, py: sy || 0, atom: atomIndex++ });
    }
  }
  // Screen objects: screen_loc tiles of the client's view, centred on the dump's centre.
  if (Array.isArray(dump.screen) && dump.screen.length) {
    const [vw, vh] = viewSize(dump.view, [x2 - x1 + 1, y2 - y1 + 1]);
    const [cx, cy] = Array.isArray(dump.center) ? dump.center : [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
    const ox = cx - Math.floor((vw - 1) / 2) - 1, oy = cy - Math.floor((vh - 1) / 2) - 1;
    let placed = 0;
    for (const [id, loc] of dump.screen) {
      const tiles = parseScreenLoc(loc, [vw, vh], size);
      if (!tiles) { bump('screen-loc-skipped', String(loc).slice(0, 60)); continue; }
      for (const t of tiles) {
        if (placed++ >= MAX_SCREEN_TILES) { bump('screen-tiles-capped', String(MAX_SCREEN_TILES)); break; }
        atoms.push(null);
        expand(id, null, { x: ox + t.tx, y: oy + t.ty, px: t.px, py: t.py, atom: atomIndex++, screen: true });
      }
    }
  }
  const pixelsOf = new Uint32Array(atomIndex);
  // Plane, layer, south over north, then the atom's own order (contents order, then
  // underlays/self/overlays).
  sprites.sort((p, q) => p.plane - q.plane || p.layer - q.layer || q.y - p.y || p.atom - q.atom || p.seq - q.seq || p.x - q.x);
  const masters = new Map();
  for (const m of dump.plane_masters || []) {
    const a = apps[m.appearance - 1];
    if (a && (a.invisibility ?? 0) <= see) masters.set(a.plane, a);
    if (a?.filters) bump('not-modelled', `plane master filters (${m.type})`);
  }
  const main = new Float32Array(width * height * 4);
  for (let i = 3; i < main.length; i += 4) main[i] = 1; // the map background is opaque black
  let drawn = 0, surface = null, surfacePlane = null;
  const flush = () => {
    if (!surface) return;
    const m = masters.get(surfacePlane), mat = composeMatrix(colorMatrix(m.color) || null, m.alpha !== 255 && m.alpha != null ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, m.alpha / 255, 0, 0, 0, 0] : null);
    const mode = BLEND[m.blend_mode] && m.blend_mode ? BLEND[m.blend_mode] : 'overlay';
    for (let i = 0; i < surface.length; i += 4) {
      let a = surface[i + 3], r = a ? surface[i] / a : 0, g = a ? surface[i + 1] / a : 0, b = a ? surface[i + 2] / a : 0;
      // The master's colour applies to the whole plane surface, transparent pixels included.
      if (mat) [r, g, b, a] = applyMatrix(mat, r, g, b, a);
      if (a > 0 || mode === 'multiply') blendPixel(main, i, r * a, g * a, b * a, a, mode);
    }
    surface = null;
  };
  for (const s of sprites) {
    if (s.plane !== surfacePlane) { flush(); surfacePlane = s.plane; if (masters.has(s.plane)) surface = new Float32Array(width * height * 4); }
    const dmi = icons[s.icon - 1];
    if (!dmi) { bump('missing-icon', String(dump.icons[s.icon - 1]?.source ?? s.icon)); continue; }
    const state = dmi.findState(String(s.state ?? ''));
    if (!state) { if (s.state) bump('missing-state', `${dump.icons[s.icon - 1]?.source ?? s.icon}:${s.state}`); continue; }
    const pixels = dmi.frame(state, typeof s.dir === 'number' ? s.dir : 2, 1, { display: true });
    draw(surface || main, s, pixels, dmi.width, dmi.height);
    drawn++;
  }
  flush();
  function draw(dst, s, src, sw, sh) {
    const baseX = (s.x - x1) * size + s.px, baseY = (y2 - s.y) * size + size - sh - s.py;
    const sample = (ix, iy) => { // ix, iy in icon pixels from the top-left
      const si = (iy * sw + ix) * 4, a = src[si + 3] / 255; if (!a) return null;
      let c = [src[si] / 255, src[si + 1] / 255, src[si + 2] / 255, a];
      if (s.matrix) c = applyMatrix(s.matrix, ...c);
      return c;
    };
    const put = (tx, ty, c) => { if (!c || !c[3] || tx < 0 || ty < 0 || tx >= width || ty >= height) return; if (c[3] > 0.02) pixelsOf[s.atom]++; blendPixel(dst, (ty * width + tx) * 4, c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3], s.blend); };
    if (!s.transform) { for (let iy = 0; iy < sh; iy++) for (let ix = 0; ix < sw; ix++) put(baseX + ix, baseY + iy, sample(ix, iy)); return; }
    // Transformed: inverse-map each destination pixel (nearest neighbour) about the icon centre.
    const [a, b, c, d, e, f] = s.transform, det = a * e - b * d;
    if (!det) return;
    const cx = sw / 2, cy = sh / 2, reach = Math.ceil(Math.hypot(sw, sh) * Math.max(1, Math.hypot(a, b, d, e)));
    for (let oy = -reach; oy < reach; oy++) for (let ox = -reach; ox < reach; ox++) {
      const X = ox + 0.5 - c, Y = -(oy + 0.5) - f; // centre-relative, y up
      const ux = (e * X - b * Y) / det, uy = (-d * X + a * Y) / det;
      const ix = Math.floor(ux + cx), iy = Math.floor(cy - uy);
      if (ix < 0 || iy < 0 || ix >= sw || iy >= sh) continue;
      put(baseX + Math.floor(cx) + ox, baseY + Math.floor(cy) + oy, sample(ix, iy));
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < main.length; i += 4) {
    const a = main[i + 3];
    rgba[i] = Math.round(clamp(a ? main[i] / a : 0) * 255); rgba[i + 1] = Math.round(clamp(a ? main[i + 1] / a : 0) * 255);
    rgba[i + 2] = Math.round(clamp(a ? main[i + 2] / a : 0) * 255); rgba[i + 3] = Math.round(clamp(a) * 255);
  }
  const diagnostics = [...counts].map(([k, n]) => { const [code, detail] = k.split('\u0000'); return { code, detail, count: n }; })
    .sort((p, q) => p.code.localeCompare(q.code) || q.count - p.count || p.detail.localeCompare(q.detail));
  const undrawn = [];
  for (let i = 0; i < atoms.length; i++) if (atoms[i]?.clickable && !pixelsOf[i]) { const { x, y, type } = atoms[i]; undrawn.push({ x, y, type }); }
  return { width, height, rgba, drawn, diagnostics, undrawn: undrawn.slice(0, 200), undrawnCount: undrawn.length, truthLayer: 'native-initialized-world' };
}

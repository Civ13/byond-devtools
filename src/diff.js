/**
 * Semantic and visual map diff. Pure: parsed maps and pixel buffers in, results out.
 *
 * Cells are compared by their atom stacks (whitespace outside quotes ignored), never by
 * dictionary key, since a key is compression and not identity. Each changed cell reports the
 * atoms removed and added as multisets, so a reordered stack shows as a change with nothing
 * removed or added. Holes (coordinates outside every block) are reported separately.
 */
import { compactAtom } from './edit.js';

const compact = a => compactAtom(a.raw);

/** Multiset difference of two atom lists: atoms of `a` not matched in `b`, in `a`'s order. */
function minus(a, b) {
  const left = new Map();
  for (const x of b) { const k = compact(x); left.set(k, (left.get(k) || 0) + 1); }
  const out = [];
  for (const x of a) { const k = compact(x), n = left.get(k) || 0; if (n) left.set(k, n - 1); else out.push(x.raw.trim()); }
  return out;
}

/**
 * Compare two parsed maps. Returns {world, changedCells, levels, cells, truncated, types}.
 * `cells` lists at most `limit` changes in map order; counts and `levels` bounds are complete.
 * Each cell: {x, y, z, change: 'modified'|'reordered'|'added'|'removed', before, after, removed, added}.
 * 'added' and 'removed' mean the coordinate is a hole on one side.
 */
export function diffMaps(before, after, { limit = 10000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100000) throw new TypeError('Invalid limit');
  const cells = [], levels = new Map(), types = new Map();
  let changed = 0;
  const record = (x, y, z, change, b, a) => {
    changed++;
    const removed = minus(b, a), added = minus(a, b);
    const lv = levels.get(z) ?? { z, changedCells: 0, x1: x, y1: y, x2: x, y2: y };
    lv.changedCells++; lv.x1 = Math.min(lv.x1, x); lv.y1 = Math.min(lv.y1, y); lv.x2 = Math.max(lv.x2, x); lv.y2 = Math.max(lv.y2, y);
    levels.set(z, lv);
    const bump = (raw, k) => { const p = raw.replace(/\{[\s\S]*$/, '').trim(); const t = types.get(p) ?? { path: p, removed: 0, added: 0 }; t[k]++; types.set(p, t); };
    for (const r of removed) bump(r, 'removed');
    for (const r of added) bump(r, 'added');
    if (cells.length < limit) cells.push({ x, y, z, change, before: b.map(t => t.raw.trim()), after: a.map(t => t.raw.trim()), removed, added });
  };
  const stackOf = c => c.atoms.map(compact).join(',');
  for (const c of before.cells()) {
    const o = after.inspectCell(c.x, c.y, c.z);
    if (!o) { record(c.x, c.y, c.z, 'removed', c.atoms, []); continue; }
    if (stackOf(o) === stackOf(c)) continue;
    const sameAtoms = c.atoms.map(compact).sort().join(',') === o.atoms.map(compact).sort().join(',');
    record(c.x, c.y, c.z, sameAtoms ? 'reordered' : 'modified', c.atoms, o.atoms);
  }
  for (const c of after.cells()) if (!before.inspectCell(c.x, c.y, c.z)) record(c.x, c.y, c.z, 'added', [], c.atoms);
  return {
    world: { before: { ...before.world }, after: { ...after.world }, changed: ['maxX', 'maxY', 'maxZ'].some(k => before.world[k] !== after.world[k]) },
    changedCells: changed, truncated: changed > cells.length,
    levels: [...levels.values()].sort((p, q) => p.z - q.z),
    cells,
    types: [...types.values()].sort((p, q) => p.path.localeCompare(q.path)),
  };
}

/**
 * Choose a render region for a diff on level z: the changed bounding box padded by `pad`
 * tiles, clamped to the world and to at most `maxSide` tiles a side (cut from the south-west
 * corner of the change). Returns {x1, y1, x2, y2, z, clipped} or null when z has no changes.
 */
export function diffRegion(diff, { z, pad = 2, maxSide = 64 } = {}) {
  const lv = z === undefined ? diff.levels[0] : diff.levels.find(l => l.z === z);
  if (!lv) return null;
  const w = { maxX: Math.min(diff.world.before.maxX, diff.world.after.maxX), maxY: Math.min(diff.world.before.maxY, diff.world.after.maxY) };
  let x1 = Math.max(1, lv.x1 - pad), y1 = Math.max(1, lv.y1 - pad), x2 = Math.min(w.maxX, lv.x2 + pad), y2 = Math.min(w.maxY, lv.y2 + pad);
  let clipped = false;
  if (x2 - x1 + 1 > maxSide) { x2 = x1 + maxSide - 1; clipped = true; }
  if (y2 - y1 + 1 > maxSide) { y2 = y1 + maxSide - 1; clipped = true; }
  return { x1, y1, x2, y2, z: lv.z, clipped };
}

/** Every changed cell of one region, unlimited (the region is bounded by the renderer). */
export function regionChanges(before, after, { x1, y1, x2, y2, z }) {
  const out = [];
  for (let y = y2; y >= y1; y--) for (let x = x1; x <= x2; x++) {
    const b = before.inspectCell(x, y, z), a = after.inspectCell(x, y, z);
    if (!b && !a) continue;
    if (!b || !a) { out.push({ x, y, z, change: b ? 'removed' : 'added' }); continue; }
    const sb = b.atoms.map(compact), sa = a.atoms.map(compact);
    if (sb.join(',') === sa.join(',')) continue;
    out.push({ x, y, z, change: [...sb].sort().join(',') === [...sa].sort().join(',') ? 'reordered' : 'modified' });
  }
  return out;
}

const COLORS = { modified: [255, 210, 0], reordered: [80, 160, 255], added: [40, 220, 80], removed: [255, 60, 60] };

/**
 * Compose before | after | highlight panels from two renders of the same region.
 * The highlight panel is the after render with unchanged tiles dimmed and each changed tile
 * outlined: yellow modified, blue reordered, green added (hole before), red removed (hole after).
 * A changed tile whose atoms were only added is still 'modified'; the colour follows `change`.
 */
export function composeDiff(beforeImg, afterImg, changes, region, iconSize, { gap = 4 } = {}) {
  if (beforeImg.width !== afterImg.width || beforeImg.height !== afterImg.height) throw new RangeError('Renders differ in size');
  const pw = beforeImg.width, ph = beforeImg.height, width = pw * 3 + gap * 2, height = ph;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) { rgba[i * 4] = 40; rgba[i * 4 + 1] = 40; rgba[i * 4 + 2] = 40; rgba[i * 4 + 3] = 255; }
  const paste = (src, ox, dim) => {
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const si = (y * pw + x) * 4, di = (y * width + ox + x) * 4, a = src.rgba[si + 3] / 255;
      for (let c = 0; c < 3; c++) {
        let v = src.rgba[si + c] * a + 40 * (1 - a);
        if (dim && dim(x, y)) v = v * 0.35 + 128 * 0.15;
        rgba[di + c] = Math.round(v);
      }
      rgba[di + 3] = 255;
    }
  };
  const changed = new Map();
  for (const c of changes) if (c.z === region.z && c.x >= region.x1 && c.x <= region.x2 && c.y >= region.y1 && c.y <= region.y2) changed.set(`${c.x},${c.y}`, c.change);
  const tileAt = (px, py) => `${region.x1 + Math.floor(px / iconSize)},${region.y2 - Math.floor(py / iconSize)}`;
  paste(beforeImg, 0); paste(afterImg, pw + gap);
  const hx = (pw + gap) * 2;
  paste(afterImg, hx, (x, y) => !changed.has(tileAt(x, y)));
  const t = Math.max(1, Math.round(iconSize / 16));
  let outlined = 0;
  for (const [key, change] of changed) {
    const [x, y] = key.split(',').map(Number), col = COLORS[change];
    const ox = hx + (x - region.x1) * iconSize, oy = (region.y2 - y) * iconSize;
    for (let py = 0; py < iconSize; py++) for (let px = 0; px < iconSize; px++) {
      if (px >= t && py >= t && px < iconSize - t && py < iconSize - t) continue;
      const di = ((oy + py) * width + ox + px) * 4; rgba[di] = col[0]; rgba[di + 1] = col[1]; rgba[di + 2] = col[2];
    }
    outlined++;
  }
  return { width, height, rgba, panels: { before: { x: 0 }, after: { x: pw + gap }, highlight: { x: hx }, width: pw, height: ph }, outlined };
}

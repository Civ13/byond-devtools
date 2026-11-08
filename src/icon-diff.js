/**
 * Compare two versions of a DMI state by state: which states were added, removed or changed
 * (size, dirs, frames, delays or pixels), and a review image with one row per changed state:
 * before | after | heatmap, each a sheet of every dir (rows) by frame (columns). Pure: takes
 * decoded icons (decodeDmi) or null for a missing side.
 */
import { DIR_ORDER } from './dmi.js';
import { frameSheet, sideBySide, compareImages } from './image.js';

const stateKey = s => `${s.movement ? 'move:' : ''}${s.name}`;

function sheetOf(icon, state) {
  const frames = [];
  for (const d of DIR_ORDER.slice(0, state.dirs)) for (let f = 1; f <= state.frames; f++) frames.push(icon.frame(state, d, f));
  return frameSheet(frames, { width: icon.width, height: icon.height, columns: state.frames });
}

function blank(width, height) { return { width, height, rgba: new Uint8Array(width * height * 4) }; }

/** Stack images top to bottom with a gap, left-aligned. */
function stack(images, gap = 6) {
  const W = Math.max(...images.map(i => i.width)), H = images.reduce((s, i) => s + i.height, 0) + gap * (images.length - 1);
  const rgba = new Uint8Array(W * H * 4);
  let oy = 0;
  for (const img of images) {
    for (let y = 0; y < img.height; y++) rgba.set(img.rgba.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((oy + y) * W) * 4);
    oy += img.height + gap;
  }
  return { width: W, height: H, rgba };
}

/**
 * before/after: decoded DMIs (null when the file did not exist). Returns {summary, states:
 * [{state, movement, change: added|removed|changed|same, details, differentPixels?}], image|null}.
 * image has at most maxRows rows (changed, then added, then removed states).
 */
export function diffIcons(before, after, { threshold = 0, maxRows = 40 } = {}) {
  const byKey = icon => new Map((icon?.states ?? []).map(s => [stateKey(s), s]));
  const a = byKey(before), b = byKey(after);
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  const states = [], rows = [];
  const sizeChanged = before && after && (before.width !== after.width || before.height !== after.height);
  for (const key of keys) {
    const sa = a.get(key), sb = b.get(key), base = { state: (sa ?? sb).name, movement: !!(sa ?? sb).movement };
    if (!sa) { states.push({ ...base, change: 'added', details: `${sb.dirs} dirs x ${sb.frames} frames` }); rows.push({ order: 1, key, after: sheetOf(after, sb) }); continue; }
    if (!sb) { states.push({ ...base, change: 'removed', details: `${sa.dirs} dirs x ${sa.frames} frames` }); rows.push({ order: 2, key, before: sheetOf(before, sa) }); continue; }
    const details = [];
    if (sizeChanged) details.push(`size ${before.width}x${before.height} -> ${after.width}x${after.height}`);
    if (sa.dirs !== sb.dirs) details.push(`dirs ${sa.dirs} -> ${sb.dirs}`);
    if (sa.frames !== sb.frames) details.push(`frames ${sa.frames} -> ${sb.frames}`);
    if (JSON.stringify(sa.delay ?? null) !== JSON.stringify(sb.delay ?? null)) details.push('delays changed');
    if (sa.loop !== sb.loop || sa.rewind !== sb.rewind) details.push('loop or rewind changed');
    const pa = sheetOf(before, sa), pb = sheetOf(after, sb), cmp = compareImages(pa, pb, { threshold, heatmap: true });
    if (cmp.differentPixels) details.push(`${cmp.differentPixels} pixels differ`);
    if (!details.length) { states.push({ ...base, change: 'same' }); continue; }
    states.push({ ...base, change: 'changed', details: details.join(', '), differentPixels: cmp.differentPixels, bounds: cmp.bounds });
    rows.push({ order: 0, key, before: pa, after: pb, heat: cmp.heatmap });
  }
  rows.sort((p, q) => p.order - q.order || p.key.localeCompare(q.key));
  const shown = rows.slice(0, maxRows);
  let image = null;
  if (shown.length) {
    image = stack(shown.map(r => {
      const ref = r.before ?? r.after;
      return sideBySide([r.before ?? blank(ref.width, ref.height), r.after ?? blank(ref.width, ref.height), r.heat ?? blank(ref.width, ref.height)], 4);
    }));
  }
  const count = c => states.filter(s => s.change === c).length;
  return { summary: { added: count('added'), removed: count('removed'), changed: count('changed'), same: count('same'),
    rowsShown: shown.length, rowsOmitted: rows.length - shown.length, columns: ['before', 'after', 'heatmap'] }, states, image };
}

/**
 * DMI (BYOND icon) reader: PNG pixels plus the zTXt "Description" metadata block.
 * Frame order, recorded against DreamDaemon 516.1688 icon.GetPixel (fixtures/dmi):
 * icons are laid out row-major in a grid `floor(pngWidth / width)` columns wide; states follow
 * in metadata order; within a state, frame-major then direction in the order
 * SOUTH, NORTH, EAST, WEST, SOUTHEAST, SOUTHWEST, NORTHEAST, NORTHWEST.
 */
import { decodePng } from './png.js';

export class DmiError extends Error { constructor(message) { super(message); this.name = 'DmiError'; } }
export const DIR_ORDER = Object.freeze([2, 1, 4, 8, 6, 10, 5, 9]); // SOUTH NORTH EAST WEST SE SW NE NW

/** Parse the Description text. Unknown keys are kept; malformed lines are errors. */
export function parseDmiMetadata(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0].trim() !== '# BEGIN DMI') throw new DmiError('Description does not start with # BEGIN DMI');
  const meta = { version: null, width: 32, height: 32, states: [] }; let state = null, sawEnd = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '# END DMI') { sawEnd = true; break; }
    if (!line.trim()) continue;
    const m = /^(\t?)([a-z_]+) = (.*)$/.exec(line);
    if (!m) throw new DmiError(`Malformed metadata line ${i + 1}`);
    const [, indent, key, raw] = m;
    const number = () => { if (!/^-?\d+$/.test(raw)) throw new DmiError(`Expected an integer for ${key} on line ${i + 1}`); return Number(raw); };
    if (!indent) {
      if (key === 'version') meta.version = raw;
      else if (key === 'state') {
        const s = /^"((?:[^"\\]|\\.)*)"$/.exec(raw); if (!s) throw new DmiError(`Bad state name on line ${i + 1}`);
        state = { name: s[1].replace(/\\(.)/g, '$1'), dirs: 1, frames: 1, delay: null, loop: 0, rewind: false, movement: false, hotspot: null, extra: {} };
        meta.states.push(state);
      } else throw new DmiError(`Unexpected top-level key ${key}`);
    } else if (!state) {
      if (key === 'width') meta.width = number(); else if (key === 'height') meta.height = number();
      else throw new DmiError(`Unexpected header key ${key}`);
    } else if (key === 'dirs') { state.dirs = number(); if (![1, 4, 8].includes(state.dirs)) throw new DmiError(`dirs must be 1, 4 or 8 (line ${i + 1})`); }
    else if (key === 'frames') { state.frames = number(); if (state.frames < 1) throw new DmiError('frames must be positive'); }
    else if (key === 'delay') state.delay = raw.split(',').map(Number);
    else if (key === 'loop') state.loop = number();
    else if (key === 'rewind') state.rewind = number() === 1;
    else if (key === 'movement') state.movement = number() === 1;
    else if (key === 'hotspot') state.hotspot = raw.split(',').map(Number);
    else state.extra[key] = raw;
  }
  if (!sawEnd) throw new DmiError('Description has no # END DMI');
  if (meta.width < 1 || meta.height < 1) throw new DmiError('Icon size must be positive');
  return meta;
}

/** Decode a DMI file. Returns an immutable icon with frame lookup and RGBA frame extraction. */
export function decodeDmi(bytes, options = {}) {
  const png = decodePng(bytes, options), description = png.text.get('Description');
  if (description === undefined) throw new DmiError('PNG has no DMI Description');
  const meta = parseDmiMetadata(description), { width, height } = meta;
  const columns = Math.floor(png.width / width), rows = Math.floor(png.height / height);
  if (columns < 1 || rows < 1) throw new DmiError('Image smaller than one icon');
  let index = 0;
  const states = meta.states.map(s => { const first = index; index += s.dirs * s.frames; return Object.freeze({ ...s, first }); });
  if (index > columns * rows) throw new DmiError(`Metadata needs ${index} icons but the image holds ${columns * rows}`);
  // A duplicated state name resolves to the FIRST state with that name (recorded natively);
  // movement states are a separate namespace; asking for movement with none gives null.
  function findState(name, { movement = false } = {}) {
    return states.find(s => s.name === name && s.movement === movement) ?? null;
  }
  /**
   * Icon index for a state, direction and 1-based frame, or -1 when the state has no such
   * direction or frame. `display` applies the map-display fallback instead: a 1-dir state shows
   * its only direction, a 4-dir state shows a diagonal as its east/west component, and frames
   * clamp. GetPixel uses the strict form (recorded natively); the display form is not.
   */
  function frameIndex(state, dir = 2, frame = 1, { display = false } = {}) {
    let d = DIR_ORDER.slice(0, state.dirs).indexOf(dir);
    if (d < 0 && display) d = state.dirs === 1 ? 0 : DIR_ORDER.indexOf(dir & 12) >= 0 && (dir & 12) ? DIR_ORDER.indexOf(dir & 12) : 0;
    if (d < 0 || d >= state.dirs) return -1;
    let f = frame;
    if (f < 1 || f > state.frames) { if (!display) return -1; f = Math.min(Math.max(1, f), state.frames); }
    return state.first + (f - 1) * state.dirs + d;
  }
  /** RGBA8 pixels of one icon frame, top row first, or null when it does not exist. */
  function frame(state, dir = 2, frameNumber = 1, options = {}) {
    const i = frameIndex(state, dir, frameNumber, options);
    if (i < 0) return null;
    const ox = (i % columns) * width, oy = Math.floor(i / columns) * height;
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.set(png.rgba.subarray(((oy + y) * png.width + ox) * 4, ((oy + y) * png.width + ox + width) * 4), y * width * 4);
    return out;
  }
  return Object.freeze({ version: meta.version, width, height, states: Object.freeze(states), sheet: { width: png.width, height: png.height, columns, rows },
    colorType: png.colorType, bitDepth: png.bitDepth, findState, frameIndex, frame });
}

/** BYOND GetPixel-style colour text: null when transparent, #rrggbb when opaque, else #rrggbbaa. */
export function pixelText(rgba, offset) {
  const a = rgba[offset + 3]; if (a === 0) return null;
  const hex = v => v.toString(16).padStart(2, '0');
  return '#' + hex(rgba[offset]) + hex(rgba[offset + 1]) + hex(rgba[offset + 2]) + (a === 255 ? '' : hex(a));
}

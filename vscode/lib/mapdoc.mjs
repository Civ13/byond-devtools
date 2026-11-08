/**
 * The editable state of one open map, independent of the VS Code API so it can be tested
 * with node:test. Every change goes through planEdit (src/edit.js), so a change is a set of
 * whole-stack replacements with expected old stacks, and the result is re-parsed and verified.
 * Saving builds one patch from the saved file to the current stacks; the extension writes it
 * with editMapFile (src/edit-project.js), never directly.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const load = async (dir, file) => import(pathToFileURL(path.join(dir, file)).href);

const kind = atom => { const p = atom.replace(/\s/g, '').match(/^\/[A-Za-z0-9_/]*/)?.[0] ?? ''; for (const k of ['area', 'turf', 'obj', 'mob']) if (p === `/${k}` || p.startsWith(`/${k}/`)) return k; return 'other'; };
const isMovable = atom => ['obj', 'mob', 'other'].includes(kind(atom));
const at = c => `${c.x},${c.y},${c.z}`;

/**
 * Stack helpers. A stack lists atoms as written in the map: movables first, then turfs, then
 * the area. Placing a movable puts it after the existing movables (on top of them); placing a
 * turf replaces the cell's turfs; placing an area replaces its area.
 */
export function placeAtom(stack, atom) {
  const k = kind(atom);
  if (k === 'area') return [...stack.filter(a => kind(a) !== 'area'), atom];
  if (k === 'turf') { const rest = stack.filter(a => kind(a) !== 'turf'), i = rest.findIndex(a => kind(a) === 'area'); return i < 0 ? [...rest, atom] : [...rest.slice(0, i), atom, ...rest.slice(i)]; }
  const i = stack.findIndex(a => !isMovable(a));
  return i < 0 ? [...stack, atom] : [...stack.slice(0, i), atom, ...stack.slice(i)];
}
/** Remove the top movable (the last one before the turf). Null when the cell has none. */
export function eraseTop(stack) {
  let i = -1; stack.forEach((a, j) => { if (isMovable(a)) i = j; });
  return i < 0 ? null : stack.filter((_, j) => j !== i);
}

export async function openMapModel({ text, core }) {
  const { parseDmm } = await load(core, 'dmm.js');
  const { planEdit, compactAtom, EditError } = await load(core, 'edit.js');
  const compact = atoms => atoms.map(a => compactAtom(a)).join(',');
  let current = text, map = parseDmm(text), saved = text, savedMap = map;
  const stackAt = (x, y, z) => { const c = map.inspectCell(x, y, z); if (!c) throw new EditError(`No authored cell at ${x},${y},${z}`); return c.atoms.map(a => a.raw.trim()); };

  /** Replace whole stacks. Returns {before, after} cell lists for undo/redo, or null if nothing changed. */
  function setCells(cells) {
    const seen = new Set(), edits = [], before = [], after = [];
    for (const c of cells) {
      if (seen.has(at(c))) throw new EditError(`Cell ${at(c)} changed twice in one edit`); seen.add(at(c));
      const old = stackAt(c.x, c.y, c.z);
      if (!Array.isArray(c.set) || !c.set.length) throw new EditError(`Cell ${at(c)} would be empty; a tile needs at least a turf`);
      if (compact(old) === compact(c.set)) continue;
      edits.push({ x: c.x, y: c.y, z: c.z, expect: old, set: c.set });
      before.push({ x: c.x, y: c.y, z: c.z, set: old }); after.push({ x: c.x, y: c.y, z: c.z, set: c.set });
    }
    if (!edits.length) return null;
    const plan = planEdit(current, { edits });
    current = plan.text; map = parseDmm(current);
    // Keep the stacks as the map now writes them, so undo expects exactly what is there.
    for (const a of after) a.set = stackAt(a.x, a.y, a.z);
    return { before, after };
  }
  const each = (cells, fn) => setCells(cells.flatMap(c => { const s = fn(stackAt(c.x, c.y, c.z)); return s ? [{ ...c, set: s }] : []; }));

  return {
    get text() { return current; },
    get map() { return map; },
    get savedText() { return saved; },
    stackAt,
    setCells,
    place: (cells, atom) => each(cells, s => placeAtom(s, atom)),
    erase: cells => each(cells, eraseTop),
    stamp: (cells, atoms) => setCells(cells.map(c => ({ ...c, set: atoms }))),
    move(from, index, to) {
      if (at(from) === at(to)) return null;
      const src = stackAt(from.x, from.y, from.z), atom = src[index];
      if (atom === undefined) throw new EditError(`No atom ${index} at ${at(from)}`);
      if (!isMovable(atom)) throw new EditError('Only objects and mobs can be moved; place a turf or area instead');
      return setCells([{ ...from, set: src.filter((_, j) => j !== index) }, { ...to, set: placeAtom(stackAt(to.x, to.y, to.z), atom) }]);
    },
    /** The cells whose stacks differ from the saved file, as a safe-edit patch body (no base). */
    savePatch() {
      const edits = [], iter = savedMap.cells(), same = new Map();
      if (current === saved) return { edits };
      for (const c of map.cells()) {
        const o = iter.next().value;
        if (!o || at(o) !== at(c)) throw new EditError('Grid layout changed; this cannot be saved as a patch');
        const pair = `${o.key}|${c.key}`;
        if (!same.has(pair)) same.set(pair, compact(o.atoms.map(a => a.raw)) === compact(c.atoms.map(a => a.raw)));
        if (!same.get(pair)) edits.push({ x: c.x, y: c.y, z: c.z, expect: o.atoms.map(a => a.raw.trim()), set: c.atoms.map(a => a.raw.trim()) });
      }
      if (!iter.next().done) throw new EditError('Grid layout changed; this cannot be saved as a patch');
      return { edits };
    },
    isDirty() { return this.savePatch().edits.length > 0; },
    /** After a save or revert: the file text becomes both the saved and the current state. */
    reset(fileText) { current = saved = fileText; map = savedMap = parseDmm(fileText); },
    /** Restore an unsaved backup over the file it was made from. */
    restore(fileText, backupText) { saved = fileText; savedMap = parseDmm(fileText); current = backupText; map = parseDmm(backupText); },
    typePaths() { return map.summary().types.map(t => t.path); },
  };
}

/**
 * Map resize. Pure: text in, text out; no filesystem, process or network access.
 *
 * The dictionary is kept byte for byte (one entry is added for the fill stack when no
 * existing entry has it), and the grid is rewritten as complete blocks in the map's own
 * style: one block per level for DMM, one column per block for TGM (as the grid was written). Each cell keeps its
 * stack, moved by the offset; cells the old grid did not author (new space or holes between
 * blocks) get the fill stack; cells moved outside the new size are cropped. The result is
 * re-parsed and every cell is compared with what it should hold.
 *
 * Spec: {maxX, maxY, maxZ, fill: [atom, ...], offsetX?, offsetY?}
 */
import { parseDmm } from './dmm.js';
import { EditError, canonicalAtom, compactStack, formatDefinition, keyToNum, numToKey, maxKeys } from './edit.js';

const LIMIT = 1000; // per axis; BYOND worlds are rarely past 500

/** Returns {text, before, after, keptCells, filledCells, croppedCells, fillKey, newKeys, orphanedKeys, verified}. */
export function planResize(source, spec) {
  const map = parseDmm(source);
  if (map.diagnostics.length) throw new EditError('Map has parser diagnostics; fix them before resizing', { diagnostics: map.diagnostics });
  const size = {};
  for (const k of ['maxX', 'maxY', 'maxZ']) {
    const v = spec?.[k] ?? map.world[k];
    if (!Number.isSafeInteger(v) || v < 1 || v > LIMIT) throw new EditError(`${k} must be a whole number from 1 to ${LIMIT}`);
    size[k] = v;
  }
  const offsetX = spec?.offsetX ?? 0, offsetY = spec?.offsetY ?? 0;
  for (const [k, v] of [['offsetX', offsetX], ['offsetY', offsetY]]) if (!Number.isSafeInteger(v) || Math.abs(v) > LIMIT) throw new EditError(`${k} must be a whole number from -${LIMIT} to ${LIMIT}`);
  if (size.maxX * size.maxY * size.maxZ > 2_000_000) throw new EditError('The resized map would have more than 2,000,000 tiles');
  const eol = /\r\n/.test(source) ? '\r\n' : '\n';
  const style = { tgm: map.definitions.some(d => /\n/.test(source.slice(d.span.start, d.span.end))), eol };
  const width = map.keyWidth;

  // Old cells by their new coordinates.
  const moved = new Map(); let cropped = 0;
  for (const c of map.cells()) {
    const x = c.x + offsetX, y = c.y + offsetY;
    if (x < 1 || y < 1 || x > size.maxX || y > size.maxY || c.z > size.maxZ) { cropped++; continue; }
    moved.set(`${x},${y},${c.z}`, c.key);
  }
  const cellsAfter = size.maxX * size.maxY * size.maxZ;
  const needsFill = moved.size < cellsAfter;

  // The fill key: an existing entry with the same stack, or a new one.
  let fillKey = null, fillStack = null; const newDefs = [];
  if (needsFill) {
    if (!Array.isArray(spec?.fill) || !spec.fill.length || !spec.fill.every(a => typeof a === 'string')) throw new EditError('fill must be a list of atom strings (a turf and an area) because the new size has tiles the map does not author');
    try { fillStack = spec.fill.map(canonicalAtom); } catch (err) { throw new EditError(`fill: ${err.message}`); }
    const isArea = a => a === '/area' || a.startsWith('/area/') || a.startsWith('/area{');
    const isTurf = a => a === '/turf' || a.startsWith('/turf/') || a.startsWith('/turf{');
    if (fillStack.filter(isArea).length !== 1 || !fillStack.some(isTurf)) throw new EditError('fill needs one turf and exactly one area');
    fillKey = map.definitions.find(d => compactStack(d.atoms) === compactStack(fillStack))?.key ?? null;
    if (!fillKey) {
      const used = new Set(map.definitions.map(d => d.key));
      let n = 0; while (n < maxKeys(width) && used.has(numToKey(n, width))) n++;
      if (n >= maxKeys(width)) throw new EditError(`no free ${width}-character dictionary key for the fill; widening keys is not supported`);
      fillKey = numToKey(n, width); newDefs.push({ key: fillKey, atoms: fillStack });
    }
  }

  // Grid text in the map's style; the separator between blocks follows the source.
  const blocks = [...map.blocks].sort((p, q) => p.span.start - q.span.start);
  const gridStart = blocks[0].span.start, gridEnd = Math.max(...blocks.map(b => b.span.end));
  // Separators follow the source: between blocks of one level, and between levels.
  const between = sameLevel => { for (let i = 1; i < blocks.length; i++) if ((blocks[i].z === blocks[i - 1].z) === sameLevel) return source.slice(blocks[i - 1].span.end, blocks[i].span.start); return null; };
  const columnSep = between(true) ?? eol, levelSep = between(false) ?? eol + eol;
  const keyAt = (x, y, z) => moved.get(`${x},${y},${z}`) ?? fillKey;
  // TGM writes one column per block; some maps have TGM columns with one-line dictionary entries.
  const columns = blocks.length > 1 && map.world.maxX > 1 ? blocks.every(b => b.width === 1) && blocks.length >= map.world.maxX : style.tgm;
  const levels = [];
  for (let z = 1; z <= size.maxZ; z++) {
    const parts = [];
    levels.push(parts);
    if (columns) {
      for (let x = 1; x <= size.maxX; x++) {
        const column = [];
        for (let y = size.maxY; y >= 1; y--) column.push(keyAt(x, y, z));
        parts.push(`(${x},1,${z}) = {"${eol}${column.join(eol)}${eol}"}`);
      }
    } else {
      const rows = [];
      for (let y = size.maxY; y >= 1; y--) { let row = ''; for (let x = 1; x <= size.maxX; x++) row += keyAt(x, y, z); rows.push(row); }
      parts.push(`(1,1,${z}) = {"${eol}${rows.join(eol)}${eol}"}`);
    }
  }
  let prefix = source.slice(0, gridStart);
  // A new dictionary entry goes in key order, as mapmerge2 writes them.
  for (const { key, atoms } of newDefs) {
    const defs = [...map.definitions].sort((p, q) => keyToNum(p.key) - keyToNum(q.key));
    const next = defs.find(d => keyToNum(d.key) > keyToNum(key));
    const text = formatDefinition(key, atoms, style);
    if (next) prefix = prefix.slice(0, next.span.start) + text + prefix.slice(next.span.start);
    else {
      const last = defs.at(-1).span.end; const nl = prefix.startsWith(eol, last) ? last + eol.length : last;
      prefix = prefix.slice(0, nl) + (nl === last ? eol + text.slice(0, -eol.length) : text) + prefix.slice(nl);
    }
  }
  const text = prefix + levels.map(parts => parts.join(columnSep)).join(levelSep) + source.slice(gridEnd);

  // Verify: dictionary unchanged, new world size, every cell as planned.
  const after = parseDmm(text);
  if (after.diagnostics.length) throw new EditError('Verification failed: the resized map has parser diagnostics', { diagnostics: after.diagnostics });
  if (['maxX', 'maxY', 'maxZ'].some(k => after.world[k] !== size[k])) throw new EditError('Verification failed: world size is not as asked');
  const oldDefs = new Map(map.definitions.map(d => [d.key, d.atoms.map(a => a.raw).join('\0')]));
  for (const d of after.definitions) if (oldDefs.has(d.key) && oldDefs.get(d.key) !== d.atoms.map(a => a.raw).join('\0')) throw new EditError(`Verification failed: entry ${d.key} changed`);
  const usedKeys = new Set(); let cells = 0, kept = 0;
  for (const c of after.cells()) {
    cells++; usedKeys.add(c.key);
    const want = keyAt(c.x, c.y, c.z);
    if (c.key !== want) throw new EditError(`Verification failed at ${c.x},${c.y},${c.z}`);
    if (moved.has(`${c.x},${c.y},${c.z}`)) kept++;
  }
  if (cells !== cellsAfter || kept !== moved.size) throw new EditError('Verification failed: cell count changed');
  const orphanedKeys = map.definitions.map(d => d.key).filter(k => !usedKeys.has(k)).sort();
  return {
    text, before: { ...map.world, cells: map.cellCount }, after: { ...size, cells: cellsAfter }, offset: { x: offsetX, y: offsetY },
    keptCells: kept, filledCells: cellsAfter - kept, croppedCells: cropped, fillKey,
    newKeys: newDefs.map(d => d.key), orphanedKeys,
    verified: { cells, bytesBefore: source.length, bytesAfter: text.length },
  };
}

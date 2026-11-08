/**
 * Copy-on-write map edits. Pure: text in, text out; no filesystem, process or network access.
 *
 * A patch replaces whole tile stacks at chosen coordinates. Every edit names the stack it
 * expects to find, so a stale patch fails instead of overwriting someone else's change.
 * Only the edited grid keys and the new dictionary entries change; every other byte of the
 * file is kept, including line endings, DMM or TGM style and unused dictionary entries.
 * The result is re-parsed and every untouched cell is compared with the original.
 *
 * Patch: {edits: [{x, y, z, expect: [atom, ...], set: [atom, ...]}], bounds?, maxEdits?}
 * Atoms are written as in a map: `/obj/item{name = "x"; dir = 4}`. Whitespace outside
 * quotes is not significant when matching `expect` or reusing an existing dictionary entry.
 */
import { parseDmm } from './dmm.js';
import { overrideAssignments } from './world.js';

export class EditError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'EditError'; Object.assign(this, details); }
}

const BASE52 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const keyToNum = k => [...k].reduce((n, c) => n * 52 + BASE52.indexOf(c), 0);
export const numToKey = (n, width) => { let s = ''; for (let i = 0; i < width; i++) { s = BASE52[n % 52] + s; n = Math.floor(n / 52); } return s; };
// BYOND accepts at most 65534 dictionary keys; mapmerge2 stays under 65530.
export const maxKeys = width => Math.min(65530, 52 ** width);

/** Remove whitespace outside quotes and a trailing `;` inside override braces. */
export function compactAtom(raw) {
  let out = '', quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) { out += c; if (c === '\\') { out += raw[++i] ?? ''; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (/\s/.test(c)) continue;
    out += c;
  }
  return out.replace(/;}$/, '}');
}
export const compactStack = atoms => atoms.map(a => compactAtom(typeof a === 'string' ? a : a.raw)).join(',');

/** mapmerge2's internal form: `path{k = v;k2 = v2}`. Rejects anything that is not `k = v` pairs. */
export function canonicalAtom(text) {
  const parsed = parseDmm(`"a" = (${text})\n(1,1,1) = {"\na\n"}\n`).definitions[0].atoms;
  if (parsed.length !== 1) throw new EditError(`Expected one atom, got ${parsed.length}: ${text}`);
  const a = parsed[0];
  if (!a.overridesRaw) return a.path;
  const body = a.overridesRaw.slice(1, -1).trim();
  const pairs = overrideAssignments(a.overridesRaw);
  if (!body || !pairs.length) throw new EditError(`Empty override block: ${text}`);
  // Every top-level piece must be a key = value pair; nothing may be dropped silently.
  const rebuilt = pairs.map(p => `${p.key} = ${p.raw}`).join(';');
  if (compactAtom(`{${rebuilt}}`) !== compactAtom(a.overridesRaw)) throw new EditError(`Unsupported override block: ${text}`);
  return `${a.path}{${rebuilt}}`;
}

function formatAtom(canonical, style) {
  const brace = canonical.indexOf('{');
  if (brace < 0) return canonical;
  // Split the canonical body on top-level ';' (outside quotes), as mapmerge2 does.
  const parts = []; let quote = false, escaped = false, part = '';
  for (const c of canonical.slice(brace + 1, -1)) {
    if (escaped) { escaped = false; part += c; continue; }
    if (c === '\\') { escaped = true; part += c; continue; }
    if (c === '"') quote = !quote;
    if (c === ';' && !quote) { parts.push(part); part = ''; continue; }
    part += c;
  }
  parts.push(part);
  return style.tgm ? `${canonical.slice(0, brace)}{${style.eol}\t${parts.join(`;${style.eol}\t`)}${style.eol}\t}` : `${canonical.slice(0, brace)}{${parts.join('; ')}}`;
}
export function formatDefinition(key, atoms, style) {
  return style.tgm ? `"${key}" = (${style.eol}${atoms.map(a => formatAtom(a, style)).join(`,${style.eol}`)})${style.eol}`
    : `"${key}" = (${atoms.map(a => formatAtom(a, style)).join(',')})${style.eol}`;
}

/** Offsets of each grid key in the source, per block row: rowStart[b][r] is the offset of column 0. */
function rowOffsets(source, block) {
  let p = source.indexOf('{"', block.span.start) + 2;
  if (source.startsWith('\r\n', p)) p += 2; else if (source[p] === '\n') p++;
  const starts = [];
  for (let r = 0; r < block.height; r++) {
    if (source.slice(p, p + block.rows[r].length) !== block.rows[r]) throw new EditError('Grid layout not understood');
    starts.push(p); p += block.rows[r].length;
    if (source.startsWith('\r\n', p)) p += 2; else if (source[p] === '\n') p++;
  }
  return starts;
}

/**
 * The same map with every dictionary key one character wider: each key keeps its number
 * (so its order) and gains a leading "a", in the dictionary and the grid. Checked cell by cell.
 */
export function widenKeys(source, map = parseDmm(source)) {
  const width = map.keyWidth, wide = k => numToKey(keyToNum(k), width + 1);
  const edits = [];
  for (const d of map.definitions) {
    if (source.slice(d.span.start, d.span.start + width + 2) !== `"${d.key}"`) throw new EditError(`Dictionary entry ${d.key} not understood`);
    edits.push([d.span.start + 1, d.span.start + 1 + width, wide(d.key)]);
  }
  for (const b of map.blocks) {
    const open = source.indexOf('{"', b.span.start) + 2, close = source.indexOf('"}', open);
    const body = source.slice(open, close);
    const text = body.replace(/[A-Za-z]+/g, row => row.match(new RegExp(`.{${width}}`, 'g')).map(wide).join(''));
    edits.push([open, close, text]);
  }
  edits.sort((p, q) => p[0] - q[0]);
  let out = '', at = 0;
  for (const [start, end, text] of edits) { out += source.slice(at, start) + text; at = end; }
  out += source.slice(at);
  const after = parseDmm(out);
  if (after.diagnostics.length || after.keyWidth !== width + 1) throw new EditError('Verification failed: widened map does not parse');
  const before = new Map(map.definitions.map(d => [wide(d.key), d.atoms.map(a => a.raw).join('\0')]));
  for (const d of after.definitions) if (before.get(d.key) !== d.atoms.map(a => a.raw).join('\0')) throw new EditError(`Verification failed: widened entry ${d.key} changed`);
  const old = new Map([...map.cells()].map(c => [`${c.x},${c.y},${c.z}`, wide(c.key)]));
  let n = 0;
  for (const c of after.cells()) { n++; if (old.get(`${c.x},${c.y},${c.z}`) !== c.key) throw new EditError(`Verification failed: widened cell ${c.x},${c.y},${c.z}`); }
  if (n !== old.size) throw new EditError('Verification failed: widened cell count changed');
  return out;
}

/**
 * Plan an edit. Returns {text, changes, newKeys, reusedKeys, orphanedKeys, inverse, verified}, plus
 * widenedKeys {from, to} when every key was taken and the map was re-keyed one character wider.
 * Throws EditError (with `edit` index where relevant) and changes nothing on any failure.
 */
export function planEdit(source, patch, options = {}) {
  try {
    return planEditAtWidth(source, patch, options);
  } catch (err) {
    if (!err?.keysFull) throw err;
    // Every key of this width is taken: re-key the map one character wider and plan again.
    const map = parseDmm(source);
    if (maxKeys(map.keyWidth + 1) <= map.definitions.length) throw new EditError(err.message.replace('; widening', ' (the map has the most entries BYOND allows);'));
    const plan = planEditAtWidth(widenKeys(source, map), patch, options);
    return { ...plan, widenedKeys: { from: map.keyWidth, to: map.keyWidth + 1 } };
  }
}

function planEditAtWidth(source, patch, { maxEdits = 10000 } = {}) {
  const map = parseDmm(source);
  if (map.diagnostics.length) throw new EditError('Map has parser diagnostics; fix them before editing', { diagnostics: map.diagnostics });
  const edits = patch?.edits;
  if (!Array.isArray(edits) || !edits.length) throw new EditError('Patch has no edits');
  const limit = Math.min(maxEdits, patch.maxEdits ?? maxEdits);
  if (edits.length > limit) throw new EditError(`Patch has ${edits.length} edits; the limit is ${limit}`);
  const eol = /\r\n/.test(source) ? '\r\n' : '\n';
  const style = { tgm: map.definitions.some(d => /\n/.test(source.slice(d.span.start, d.span.end))), eol };
  const byStack = new Map(map.definitions.map(d => [compactStack(d.atoms), d.key]));
  const used = new Set(map.definitions.map(d => d.key)), width = map.keyWidth;
  const newDefs = new Map(), seen = new Set(), changes = [];
  let nextFree = 0;
  edits.forEach((e, i) => {
    const fail = (msg, extra) => { throw new EditError(`Edit ${i}: ${msg}`, { edit: i, ...extra }); };
    for (const k of ['x', 'y', 'z']) if (!Number.isSafeInteger(e?.[k]) || e[k] < 1) fail(`invalid ${k}`);
    if (!Array.isArray(e.expect) || !Array.isArray(e.set) || !e.set.length || ![...e.expect, ...e.set].every(a => typeof a === 'string')) fail('expect and set must be lists of atom strings; set may not be empty');
    const b = patch.bounds;
    if (b && (e.x < b.x1 || e.x > b.x2 || e.y < b.y1 || e.y > b.y2 || (b.z !== undefined && e.z !== b.z))) fail('outside the patch bounds');
    const at = `${e.x},${e.y},${e.z}`; if (seen.has(at)) fail('coordinate edited twice'); seen.add(at);
    const cell = map.inspectCell(e.x, e.y, e.z);
    if (!cell) fail('no authored cell at this coordinate (cells outside existing blocks cannot be added)');
    if (compactStack(cell.atoms) !== compactStack(e.expect)) fail('stack does not match expect (stale patch?)', { actual: cell.atoms.map(a => a.raw.trim()) });
    let canonical;
    try { canonical = e.set.map(canonicalAtom); } catch (err) { fail(err.message); }
    if (canonical.filter(a => a === '/area' || a.startsWith('/area/') || a.startsWith('/area{')).length > 1) fail('more than one area (DreamMaker rejects this)');
    const stack = canonical.join(',');
    let key = byStack.get(compactStack(canonical)) ?? newDefs.get(stack)?.key;
    if (!key) {
      while (nextFree < maxKeys(width) && used.has(numToKey(nextFree, width))) nextFree++;
      if (nextFree >= maxKeys(width)) { const err = new EditError(`Edit ${i}: no free ${width}-character dictionary key; widening rewrites every key`, { edit: i }); err.keysFull = true; throw err; }
      key = numToKey(nextFree, width); used.add(key); newDefs.set(stack, { key, atoms: canonical });
    }
    changes.push({ x: e.x, y: e.y, z: e.z, oldKey: cell.key, newKey: key, old: cell.atoms.map(a => a.raw.trim()), set: e.set });
  });
  // Splice: collect [start, end, text] replacements, then apply back to front.
  const splices = [], offsets = new Map();
  for (const c of changes) {
    const block = map.blocks.find(b => b.z === c.z && c.x >= b.x && c.x <= b.maxX && c.y >= b.y && c.y <= b.maxY);
    if (!offsets.has(block)) offsets.set(block, rowOffsets(source, block));
    const start = offsets.get(block)[block.maxY - c.y] + (c.x - block.x) * width;
    if (c.oldKey !== c.newKey) splices.push([start, start + width, c.newKey]);
  }
  // New dictionary entries go in key order, as mapmerge2 writes them.
  const defs = [...map.definitions].sort((p, q) => keyToNum(p.key) - keyToNum(q.key));
  for (const { key, atoms } of newDefs.values()) {
    const next = defs.find(d => keyToNum(d.key) > keyToNum(key));
    const text = formatDefinition(key, atoms, style);
    const order = keyToNum(key);
    if (next) splices.push([next.span.start, next.span.start, text, order]);
    else { const last = defs.at(-1).span.end; const nl = source.startsWith(eol, last) ? last + eol.length : last; splices.push([nl, nl, nl === last ? eol + text.slice(0, -eol.length) : text, order]); }
  }
  // Back to front; inserts at one offset go largest key first so they end up in key order.
  splices.sort((p, q) => q[0] - p[0] || q[1] - p[1] || (q[3] ?? -1) - (p[3] ?? -1));
  let text = source;
  for (const [s, e, t] of splices) text = text.slice(0, s) + t + text.slice(e);
  const verified = verifyEdit(map, text, changes);
  const newKeys = new Set([...newDefs.values()].map(d => d.key));
  const orphanedKeys = [...new Set(changes.map(c => c.oldKey))].filter(k => !verified.usedKeys.has(k)).sort();
  return {
    text, changes: changes.map(({ x, y, z, oldKey, newKey }) => ({ x, y, z, oldKey, newKey })),
    newKeys: [...newKeys], reusedKeys: [...new Set(changes.map(c => c.newKey))].filter(k => !newKeys.has(k)).sort(),
    orphanedKeys, inverse: { edits: changes.map(c => ({ x: c.x, y: c.y, z: c.z, expect: c.set, set: c.old })) },
    verified: { cells: verified.cells, changedCells: changes.length, unchangedCells: verified.cells - changes.length, bytesBefore: source.length, bytesAfter: text.length },
  };
}

/** Re-parse the output and require: same blocks, same old dictionary, edited cells as asked, every other cell identical. */
function verifyEdit(before, text, changes) {
  const after = parseDmm(text);
  if (after.keyWidth !== before.keyWidth || after.blocks.length !== before.blocks.length) throw new EditError('Verification failed: grid structure changed');
  if (['maxX', 'maxY', 'maxZ'].some(k => after.world[k] !== before.world[k])) throw new EditError('Verification failed: world size changed');
  const oldDefs = new Map(before.definitions.map(d => [d.key, d.atoms.map(a => a.raw)]));
  for (const d of after.definitions) if (oldDefs.has(d.key) && oldDefs.get(d.key).join('\0') !== d.atoms.map(a => a.raw).join('\0')) throw new EditError(`Verification failed: entry ${d.key} changed`);
  const want = new Map(changes.map(c => [`${c.x},${c.y},${c.z}`, c]));
  const usedKeys = new Set(); let cells = 0;
  const iter = before.cells();
  for (const c of after.cells()) {
    const o = iter.next().value; cells++; usedKeys.add(c.key);
    if (!o || o.x !== c.x || o.y !== c.y || o.z !== c.z) throw new EditError('Verification failed: cell order changed');
    const w = want.get(`${c.x},${c.y},${c.z}`);
    if (w ? c.key !== w.newKey || compactStack(c.atoms) !== compactStack(w.set.map(canonicalAtom)) : c.key !== o.key) throw new EditError(`Verification failed at ${c.x},${c.y},${c.z}`);
  }
  if (!iter.next().done) throw new EditError('Verification failed: cell count changed');
  return { cells, usedKeys };
}

/** Original read-only DMM syntax inspector. Never executes DM or rewrites input. */
export class DmmError extends Error {
  constructor(message, source, offset) {
    let line = 1, lastNewline = -1;
    for (let i = 0; i < offset; i++) if (source[i] === '\n') { line++; lastNewline = i; }
    const column = offset - lastNewline;
    super(`${message} at ${line}:${column}`);
    this.name = 'DmmError'; this.offset = offset; this.line = line; this.column = column;
  }
}
const DEFAULTS = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxCells: 2_000_000,
  maxDictionary: 65534, maxBlocks: 4096, maxAtomsPerTile: 4096, maxDepth: 128 });
export function parseDmm(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('DMM source must be text');
  const limits = { ...DEFAULTS, ...options };
  for (const [k, v] of Object.entries(limits)) {
    if (!(k in DEFAULTS) || !Number.isSafeInteger(v) || v < 1 || v > DEFAULTS[k])
      throw new TypeError(`Invalid limit ${k}; limits may only be lowered`);
  }
  if (new TextEncoder().encode(source).length > limits.maxBytes) throw new RangeError('DMM byte limit exceeded');
  let pos = 0, keyWidth = 0, cellCount = 0;
  const dictionary = new Map(), blocks = [];
  const fail = (message, at = pos) => { throw new DmmError(message, source, at); };
  function skip() {
    while (pos < source.length) {
      if (/\s/.test(source[pos])) { pos++; continue; }
      if (source.startsWith('//', pos)) { const n = source.indexOf('\n', pos + 2); pos = n < 0 ? source.length : n + 1; continue; }
      if (source.startsWith('/*', pos)) { const n = source.indexOf('*/', pos + 2); if (n < 0) fail('Unterminated comment'); pos = n + 2; continue; }
      break;
    }
  }
  function expect(c) { skip(); if (source[pos] !== c) fail(`Expected ${JSON.stringify(c)}`); pos++; }
  function quoted() {
    const start = pos, quote = source[pos++];
    while (pos < source.length) {
      const c = source[pos++];
      if (c === '\\') { if (pos >= source.length) fail('Unterminated escape', start); pos++; }
      else if (c === quote) return source.slice(start, pos);
    }
    fail('Unterminated quoted value', start);
  }
  // Split only at the requested nesting level; preserve expressions as raw text.
  function balanced(open, close, separator) {
    expect(open); const pieces = []; let part = pos; const stack = [close];
    const pairs = { '(': ')', '{': '}', '[': ']' };
    while (pos < source.length) {
      const c = source[pos];
      if (c === '"' || c === "'") { quoted(); continue; }
      if (source.startsWith('//', pos) || source.startsWith('/*', pos)) { skip(); continue; }
      if (pairs[c]) { stack.push(pairs[c]); if (stack.length > limits.maxDepth) fail('Nesting limit exceeded'); pos++; continue; }
      if (')}]'.includes(c)) {
        if (c !== stack.at(-1)) fail('Mismatched closing delimiter');
        stack.pop();
        if (!stack.length) { pieces.push({ raw: source.slice(part, pos), start: part, end: pos }); pos++; return pieces; }
        pos++; continue;
      }
      if (c === separator && stack.length === 1) {
        if (pieces.length >= limits.maxAtomsPerTile - 1) fail('Expression-segment limit exceeded');
        pieces.push({ raw: source.slice(part, pos), start: part, end: pos }); part = ++pos; continue;
      }
      pos++;
    }
    fail('Unterminated balanced expression');
  }
  function positive() {
    skip(); const m = /^[0-9]+/.exec(source.slice(pos)); if (!m) fail('Expected positive coordinate');
    pos += m[0].length; const v = Number(m[0]);
    if (!Number.isSafeInteger(v) || v < 1) fail('Coordinate must be a positive safe integer');
    return v;
  }
  function atom(piece) {
    const raw = piece.raw.trim();
    // Map atom paths are identifiers. Override bodies remain opaque and unexecuted.
    const m = /^(\/(?:[A-Za-z_][A-Za-z0-9_]*)(?:\/[A-Za-z_][A-Za-z0-9_]*)*)\s*([\s\S]*)$/.exec(raw);
    if (!m) fail('Unsupported or invalid atom path', piece.start);
    const rest = m[2].trim();
    if (rest && !(rest.startsWith('{') && rest.endsWith('}'))) fail('Expected atom override block', piece.start);
    // Confirm exactly one override group, not adjacent blocks or trailing expressions.
    if (rest) {
      const saved = pos; pos = piece.start + piece.raw.indexOf('{');
      balanced('{', '}', ';');
      const tail = source.slice(pos, piece.end).trim(); pos = saved;
      if (tail) fail('Trailing content after overrides', piece.start);
    }
    return Object.freeze({ path: m[1], overridesRaw: rest || null, raw: piece.raw,
      span: Object.freeze({ start: piece.start, end: piece.end }) });
  }
  while (true) {
    skip(); if (pos === source.length) break;
    const start = pos;
    if (source[pos] === '"') {
      const token = quoted(); const key = token.slice(1, -1);
      if (!/^[A-Za-z]{1,8}$/.test(key)) fail('Unsupported dictionary key', start);
      if (dictionary.has(key)) fail(`Duplicate dictionary key ${key}`, start);
      if (!keyWidth) keyWidth = key.length;
      if (key.length !== keyWidth) fail('Mixed dictionary key widths', start);
      if (dictionary.size >= limits.maxDictionary) fail('Dictionary limit exceeded', start);
      expect('='); const pieces = balanced('(', ')', ',');
      if (pieces.length > limits.maxAtomsPerTile) fail('Atoms-per-tile limit exceeded', start);
      const atoms = pieces.map(atom);
      dictionary.set(key, Object.freeze({ key, atoms: Object.freeze(atoms), span: Object.freeze({ start, end: pos }) }));
    } else if (source[pos] === '(') {
      if (blocks.length >= limits.maxBlocks) fail('Block limit exceeded', start);
      expect('('); const x = positive(); expect(','); const y = positive(); expect(','); const z = positive(); expect(')'); expect('='); expect('{'); expect('"');
      const bodyStart = pos; const end = source.indexOf('"', pos); if (end < 0) fail('Unterminated grid');
      let body = source.slice(bodyStart, end).replaceAll('\r\n', '\n'); pos = end + 1; expect('}');
      if (body.startsWith('\n')) body = body.slice(1);
      if (body.endsWith('\n')) body = body.slice(0, -1);
      let rowCount = 1;
      for (let i = 0; i < body.length; i++) if (body[i] === '\n' && ++rowCount > limits.maxCells) fail('Cell limit exceeded', start);
      const rows = body.split('\n');
      if (!keyWidth) fail('Dictionary must precede grid blocks', start);
      const width = rows[0].length / keyWidth, height = rows.length;
      if (!Number.isInteger(width) || width < 1 || rows.some(r => r.length !== width * keyWidth || !/^[A-Za-z]+$/.test(r))) fail('Invalid grid row or key width', start);
      const maxX = x + (width - 1), maxY = y + (height - 1);
      if (!Number.isSafeInteger(maxX) || !Number.isSafeInteger(maxY)) fail('Coordinate overflow', start);
      cellCount += width * height; if (!Number.isSafeInteger(cellCount) || cellCount > limits.maxCells) fail('Cell limit exceeded', start);
      for (const b of blocks) if (b.z === z && x <= b.maxX && maxX >= b.x && y <= b.maxY && maxY >= b.y) fail('Overlapping grid blocks', start);
      for (const row of rows) for (let i = 0; i < row.length; i += keyWidth) if (!dictionary.has(row.slice(i, i + keyWidth))) fail(`Undefined grid key ${row.slice(i, i + keyWidth)}`, start);
      blocks.push(Object.freeze({ x, y, z, maxX, maxY, width, height, rows: Object.freeze(rows), span: Object.freeze({ start, end: pos }) }));
    } else fail('Unexpected top-level content');
  }
  if (!dictionary.size || !blocks.length) fail('Map must contain dictionary and grid blocks');
  const freeze = Object.freeze;
  // Lazy z -> x -> covering blocks index. Total entries equal summed block widths (<= cellCount).
  let columns = null;
  function columnIndex() {
    if (columns) return columns;
    columns = new Map();
    for (const b of blocks) {
      let level = columns.get(b.z); if (!level) columns.set(b.z, level = new Map());
      for (let x = b.x; x <= b.maxX; x++) { const list = level.get(x); if (list) list.push(b); else level.set(x, [b]); }
    }
    return columns;
  }
  function inspectCell(x, y, z) {
    if (![x,y,z].every(v => Number.isSafeInteger(v) && v > 0)) throw new TypeError('Coordinates must be positive safe integers');
    const b = (columnIndex().get(z)?.get(x) || []).find(b => y >= b.y && y <= b.maxY);
    if (!b) return null;
    const index = (x - b.x) * keyWidth, key = b.rows[b.maxY - y].slice(index, index + keyWidth);
    return freeze({ x, y, z, key, atoms: dictionary.get(key).atoms });
  }
  function* cells() {
    for (const b of blocks) for (let row = 0; row < b.height; row++) for (let col = 0; col < b.width; col++) {
      const key = b.rows[row].slice(col * keyWidth, (col + 1) * keyWidth);
      yield freeze({ x: b.x + col, y: b.maxY - row, z: b.z, key, atoms: dictionary.get(key).atoms });
    }
  }
  function summary() {
    const counts = new Map(), occupancy = new Map();
    for (const c of cells()) occupancy.set(c.key, (occupancy.get(c.key) || 0) + 1);
    for (const [key, count] of occupancy) for (const a of dictionary.get(key).atoms) counts.set(a.path, (counts.get(a.path) || 0) + count);
    return { schemaVersion: 1, truthLayer: 'authored-source', keyWidth, dictionaryEntries: dictionary.size, cellCount,
      bounds: { minX: Math.min(...blocks.map(b=>b.x)), minY: Math.min(...blocks.map(b=>b.y)), minZ: Math.min(...blocks.map(b=>b.z)),
        maxX: Math.max(...blocks.map(b=>b.maxX)), maxY: Math.max(...blocks.map(b=>b.maxY)), maxZ: Math.max(...blocks.map(b=>b.z)) },
      levels: [...new Set(blocks.map(b=>b.z))].sort((a,b)=>a-b), blockCount: blocks.length,
      types: [...counts].sort(([a],[b])=>a.localeCompare(b)).map(([path,instances])=>({path,instances})),
      limitations: ['No DM expression evaluation, inheritance, DMI rendering, runtime or save-state validation.','Sparse/offset blocks are preserved; rectangular world completeness is not asserted.'] };
  }
  function find(path, { includeSubtypes = false, limit = 100, offset = 0 } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('Expected type path');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid pagination');
    const matchingKeys = new Set([...dictionary].filter(([, tile])=>tile.atoms.some(a=>a.path === path || (includeSubtypes && a.path.startsWith(path + '/')))).map(([key])=>key));
    const results = []; let matched = 0;
    for (const c of cells()) if (matchingKeys.has(c.key)) {
      if (matched >= offset && results.length < limit) results.push(freeze({x:c.x,y:c.y,z:c.z,key:c.key})); matched++;
    }
    return { results, matchedCells: matched, offset, limit, truncated: offset + results.length < matched, exhaustiveCount: true };
  }
  return freeze({ source, keyWidth, cellCount, blocks: freeze(blocks), definitions: freeze([...dictionary.values()]), inspectCell, cells, summary, find });
}

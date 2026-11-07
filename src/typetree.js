/**
 * Native DM type tree from `DreamMaker -o` output. Pure: no filesystem or process access.
 *
 * DreamMaker prints the compiled object tree as XML with every type, var and proc and the
 * file:line that declared or overrode it. Its printed values are NOT evaluated: operators
 * are dropped (`2 + 0.1` prints `20.1`, `4|1` prints `41`). A value is therefore only
 * reported as resolved when the declaring source line holds one plain literal, or one
 * identifier that a non-conflicting `#define` maps to a plain literal. Everything else
 * keeps its source text and is marked unresolved.
 */
export class TypeTreeError extends Error { constructor(message) { super(message); this.name = 'TypeTreeError'; } }

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e]);
const KINDS = new Set(['object', 'area', 'turf', 'obj', 'mob']);
// Builtin parents for root types that DreamMaker prints without declaring them.
const BUILTIN_PARENT = { '/atom': '/datum', '/atom/movable': '/atom', '/turf': '/atom', '/area': '/atom', '/obj': '/atom/movable', '/mob': '/atom/movable' };

function parseLocation(attr) {
  const m = /^(.*):(\d+)$/.exec(attr || '');
  return m ? { file: m[1], line: Number(m[2]) } : { file: null, line: null };
}

/** Parse `DreamMaker -o` XML text into an immutable tree. Limits bound input size and node count. */
export function parseTypeTree(xml, { maxBytes = 64 * 1024 * 1024, maxTypes = 200000 } = {}) {
  if (typeof xml !== 'string') throw new TypeError('Type tree must be text');
  if (xml.length > maxBytes) throw new RangeError('Type tree byte limit exceeded');
  const start = xml.indexOf('<dm>');
  if (start < 0) throw new TypeTreeError('No <dm> object tree found (was DreamMaker run with -o?)');
  const types = new Map(), stack = [];
  const tag = /<(\/?)([a-z]+)((?:\s+[a-z_]+="[^"]*")*)\s*(\/?)>/g;
  tag.lastIndex = start;
  let m, pendingVar = null, recovered = 0;
  while ((m = tag.exec(xml))) {
    const [, closing, name, attrs, selfClosing] = m;
    const textEnd = xml.indexOf('<', tag.lastIndex), text = decode(xml.slice(tag.lastIndex, textEnd < 0 ? undefined : textEnd)).trim();
    const loc = parseLocation(/file="([^"]*)"/.exec(attrs)?.[1]);
    if (closing) {
      if (name === 'dm') break;
      // DreamMaker leaves a <var> unclosed when its value fails to compile (for example a
      // missing resource file). Close such vars implicitly; anything else is malformed.
      while (stack.at(-1)?.tag === 'var' && name !== 'var') { stack.pop(); recovered++; }
      const top = stack.pop();
      if (!top || top.tag !== name) throw new TypeTreeError(`Mismatched </${name}>`);
      if (name === 'var') pendingVar = null;
      continue;
    }
    if (name !== 'val' && name !== 'list' && name !== 'item' && stack.at(-1)?.tag === 'var') { stack.pop(); recovered++; pendingVar = null; }
    if (KINDS.has(name)) {
      const parent = stack.findLast(s => s.type)?.type;
      const path = (parent ? parent.path : '') + '/' + text;
      if (!/^(\/[A-Za-z_][A-Za-z0-9_]*)+$/.test(path)) throw new TypeTreeError(`Invalid type path ${path}`);
      let type = types.get(path);
      if (!type) {
        if (types.size >= maxTypes) throw new RangeError('Type count limit exceeded');
        type = { path, kind: name, file: loc.file, line: loc.line, lexicalParent: parent ? parent.path : null, vars: new Map(), procs: 0 };
        types.set(path, type);
      }
      if (!selfClosing) stack.push({ tag: name, type });
    } else if (name === 'var') {
      const owner = stack.findLast(s => s.type)?.type;
      pendingVar = owner ? { name: text, file: loc.file, line: loc.line, printed: null } : null;
      if (pendingVar) owner.vars.set(text, pendingVar);
      if (!selfClosing) stack.push({ tag: name });
    } else if (name === 'val') {
      if (pendingVar && pendingVar.printed === null) pendingVar.printed = text;
      if (!selfClosing) stack.push({ tag: name });
    } else if (name === 'proc' || name === 'verb') {
      const owner = stack.findLast(s => s.type)?.type; if (owner) owner.procs++;
      if (!selfClosing) stack.push({ tag: name });
    } else if (!selfClosing) stack.push({ tag: name });
  }
  for (const type of types.values()) {
    const declared = type.vars.get('parent_type')?.printed;
    type.parent = declared && /^\/[A-Za-z_]/.test(declared) ? declared
      : type.lexicalParent ?? (BUILTIN_PARENT[type.path] ?? (type.path === '/datum' ? null : '/datum'));
    if (type.path === '/atom/movable' && !declared) type.parent = '/atom';
  }
  return makeTree(types, recovered);
}

function makeTree(types, recovered = 0) {
  function has(path) { return types.has(path) || path in BUILTIN_PARENT || path === '/datum'; }
  /** Ancestors from the type itself up to /datum, stopping on cycles or unknown parents. */
  function chain(path) {
    const out = [], seen = new Set();
    for (let p = path; p && !seen.has(p); p = types.get(p)?.parent ?? BUILTIN_PARENT[p] ?? (p === '/datum' ? null : '/datum')) {
      seen.add(p); out.push(p);
    }
    return out;
  }
  /** Nearest var entry for `name` on the type or an ancestor, with the type it came from. */
  function lookupVar(path, name) {
    for (const p of chain(path)) { const v = types.get(p)?.vars.get(name); if (v) return { ...v, from: p }; }
    return null;
  }
  function isA(path, ancestor) { return chain(path).includes(ancestor); }
  return Object.freeze({ size: types.size, recoveredTags: recovered, has, chain, lookupVar, isA, paths: () => [...types.keys()].sort(),
    get: path => { const t = types.get(path); return t ? { ...t, vars: [...t.vars.keys()].sort() } : null; } });
}

// DreamMaker's built-in constants, recorded from DreamDaemon 516.1688 (fixtures/native/builtin-defines.json).
export const BUILTIN_DEFINES = Object.freeze({ TRUE: 1, FALSE: 0, NORTH: 1, SOUTH: 2, EAST: 4, WEST: 8, NORTHEAST: 5,
  NORTHWEST: 9, SOUTHEAST: 6, SOUTHWEST: 10, UP: 16, DOWN: 32, AREA_LAYER: 1, TURF_LAYER: 2, OBJ_LAYER: 3, MOB_LAYER: 4,
  FLY_LAYER: 5, EFFECTS_LAYER: 5000, TOPDOWN_LAYER: 10000, BACKGROUND_LAYER: 20000, FLOAT_LAYER: -1, FLOAT_PLANE: -32767 });

/** Lexical `#define NAME literal` table. A name defined twice with different text is ambiguous. */
export function collectDefines(files) {
  const defines = new Map(Object.entries(BUILTIN_DEFINES).map(([k, v]) => [k, String(v)]));
  for (const text of files) for (const line of text.split(/\r?\n/)) {
    const m = /^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+?)\s*(?:\/\/.*)?$/.exec(line);
    if (!m) continue;
    const [, name, body] = m, prior = defines.get(name);
    defines.set(name, prior === undefined || prior === body ? body : null);
  }
  return defines;
}

// Strings qualify only without embedded expressions or text macros (\\improper, \\n, ...).
const LITERAL = /^(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|"(?:[^"\\\[\]]|\\["\\])*"|'[^']*'|null|(?:\/[A-Za-z_][A-Za-z0-9_]*)+)$/i;
function literalValue(raw) {
  if (raw === 'null') return null;
  if (/^-?\d/.test(raw)) return Number(raw);
  if (raw[0] === '"') return raw.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (raw[0] === "'") return { resource: raw.slice(1, -1) };
  return { path: raw };
}
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '/' && text[i + 1] === '/') return text.slice(0, i);
  }
  return text;
}

/**
 * Resolve a var entry against its declaring source line. `sourceLine(file, line)` returns the
 * line text or null. Returns {status:'literal'|'define'|'unresolved'|'unset', raw, value}.
 */
export function resolveVar(entry, sourceLine, defines = new Map()) {
  if (!entry) return { status: 'unset', raw: null, value: undefined };
  const text = entry.file && sourceLine(entry.file, entry.line);
  if (text == null) return { status: 'unresolved', raw: null, value: undefined, reason: 'source line unavailable' };
  const m = new RegExp(`(?:^|[\\s/])${entry.name}\\s*=\\s*(.*)$`).exec(stripComment(text));
  if (!m) return { status: entry.printed === null ? 'unset' : 'unresolved', raw: null, value: undefined, reason: 'no assignment on the declaring line' };
  return parseValue(m[1].trim().replace(/;$/, '').trim(), defines);
}

/** Resolve one DM value expression the same way: literal, macro for a literal, simple arithmetic. */
export function parseValue(raw, defines = new Map()) {
  if (LITERAL.test(raw)) return { status: 'literal', raw, value: literalValue(raw) };
  const body = /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) ? defines.get(raw) : undefined;
  if (body && LITERAL.test(body.trim())) return { status: 'define', raw, value: literalValue(body.trim()) };
  const folded = foldArithmetic(raw, defines);
  if (folded !== undefined) return { status: 'folded', raw, value: folded };
  return { status: 'unresolved', raw, value: undefined, reason: body === null ? 'macro defined more than once' : 'expression' };
}

/**
 * Fold `term (+|-|*|/ term)*` where each term is a number or a macro that resolves to one,
 * with DM's operator precedence and 32-bit float arithmetic. Anything else returns undefined.
 */
export function foldArithmetic(raw, defines = new Map(), depth = 0) {
  if (depth > 8 || raw.length > 200) return undefined;
  const tokens = raw.match(/\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/]|\S)/g)?.map(t => t.trim());
  if (!tokens || tokens.join('') !== raw.replace(/\s+/g, '')) return undefined;
  const term = t => {
    if (/^\d/.test(t)) return Math.fround(Number(t));
    const body = defines.get(t);
    if (typeof body !== 'string') return undefined;
    const b = body.trim().replace(/^\((.*)\)$/, '$1');
    return /^-?\d+(\.\d+)?$/.test(b) ? Math.fround(Number(b)) : foldArithmetic(b, defines, depth + 1);
  };
  // Unary minus only at the start; then alternate term/operator.
  let i = 0, sign = 1;
  if (tokens[0] === '-') { sign = -1; i = 1; }
  const values = [], ops = [];
  for (; i < tokens.length; i += 2) {
    const v = term(tokens[i]); if (v === undefined) return undefined;
    values.push(values.length ? v : sign * v);
    if (i + 1 < tokens.length) { if (!'+-*/'.includes(tokens[i + 1])) return undefined; ops.push(tokens[i + 1]); }
  }
  if (values.length !== ops.length + 1) return undefined;
  for (let k = 0; k < ops.length;) {
    if (ops[k] === '*' || ops[k] === '/') {
      if (ops[k] === '/' && values[k + 1] === 0) return undefined;
      values.splice(k, 2, Math.fround(ops[k] === '*' ? values[k] * values[k + 1] : values[k] / values[k + 1])); ops.splice(k, 1);
    } else k++;
  }
  let acc = values[0];
  ops.forEach((op, k) => { acc = Math.fround(op === '+' ? acc + values[k + 1] : acc - values[k + 1]); });
  return acc;
}

const BUILTIN_ATOM_VARS = new Set(`alpha appearance appearance_flags blend_mode color contents density desc dir filters
gender icon icon_state icon_w icon_z invisibility infra_luminosity layer luminosity maptext maptext_width maptext_height
maptext_x maptext_y mouse_over_pointer mouse_drag_pointer mouse_drop_pointer mouse_drop_zone mouse_opacity name opacity
overlays override pixel_w pixel_x pixel_y pixel_z plane render_source render_target suffix text type underlays
vis_contents vis_flags vis_locs verbs x y z loc locs tag parent_type vars animate_movement bound_height bound_width
bound_x bound_y glide_size particles screen_loc step_size step_x step_y ckey client group key see_in_dark see_infrared
see_invisible sight`.split(/\s+/));

/** Semantic map lint against a type tree: unknown type paths and overrides of undeclared vars. */
export function lintMap(map, tree, { overrideKeys = () => [] } = {}) {
  const problems = [], seen = new Set();
  for (const d of map.definitions) for (const a of d.atoms) {
    if (!tree.has(a.path)) { if (!seen.has(a.path)) problems.push({ code: 'unknown-type', severity: 'error', path: a.path, key: d.key, span: a.span }); seen.add(a.path); continue; }
    for (const key of overrideKeys(a.overridesRaw)) {
      if (BUILTIN_ATOM_VARS.has(key) || tree.lookupVar(a.path, key)) continue;
      problems.push({ code: 'undefined-var', severity: 'error', path: a.path, var: key, key: d.key, span: a.span });
    }
  }
  const usage = new Map();
  for (const c of map.cells()) usage.set(c.key, (usage.get(c.key) || 0) + 1);
  return { schemaVersion: 1, truthLayer: 'native-type-tree', problems: problems.map(p => ({ ...p, cells: usage.get(p.key) || 0 })),
    counts: { 'unknown-type': problems.filter(p => p.code === 'unknown-type').length, 'undefined-var': problems.filter(p => p.code === 'undefined-var').length } };
}

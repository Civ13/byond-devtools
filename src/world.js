/**
 * Expected native world for a parsed map, and comparison against a native DreamDaemon dump.
 * Pure: no filesystem, process or network access. The rules below are the ones recorded
 * against DreamDaemon 516.1688 in fixtures/native; they are not inferred from documentation.
 *
 * - World size: maxx/maxy/maxz are the largest placed x, y and z. Missing cells become the
 *   default world turf (/turf) inside the default area (/area).
 * - A tile with several turfs keeps the LAST turf as the turf; earlier ones become underlays.
 * - A tile with no turf gets /turf. A tile with no area gets /area.
 * - Movables (everything that is not a turf or area) enter turf.contents in authored order,
 *   except that mobs come after every obj: the loader places objs first, then mobs.
 * - A color override of six-digit hex is stored lower case, and white (#ffffff) becomes null.
 */
const isTurf = p => p === '/turf' || p.startsWith('/turf/');
const isArea = p => p === '/area' || p.startsWith('/area/');
const isMob = p => p === '/mob' || p.startsWith('/mob/');

/** Literal `key = value` pairs from an override block. Anything not a plain literal is skipped. */
export function literalOverrides(overridesRaw) { return overrideAssignments(overridesRaw).filter(o => o.expected !== undefined); }

/** Every `key = value` assignment; `expected` is set only for plain integer or string literals. */
export function overrideAssignments(overridesRaw) {
  if (!overridesRaw) return [];
  const body = overridesRaw.slice(1, -1), out = [];
  // Split on top-level semicolons while respecting quotes and brackets.
  let depth = 0, quote = null, part = '';
  const pieces = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { part += c; if (c === '\\') { part += body[++i] ?? ''; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; part += c; continue; }
    if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    if (c === ';' && depth === 0) { pieces.push(part); part = ''; continue; }
    part += c;
  }
  pieces.push(part);
  for (const piece of pieces) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*?)\s*$/.exec(piece);
    if (!m) continue;
    const [, key, raw] = m;
    if (key === 'color') {
      const hex = /^"(#[0-9A-Fa-f]{6})"$/.exec(raw);
      out.push({ key, raw, expected: hex ? (hex[1].toLowerCase() === '#ffffff' ? '' : hex[1].toLowerCase()) : undefined });
    } else if (/^-?(0|[1-9][0-9]{0,5})$/.test(raw)) out.push({ key, raw, expected: String(Number(raw)) });
    else if (/^"[^"\\\[\]]*"$/.test(raw)) out.push({ key, raw, expected: raw.slice(1, -1) });
    else out.push({ key, raw, expected: undefined });
  }
  return out;
}

/** Every override key used by the map, so a harness can ask DreamDaemon for those vars. */
export function overrideKeys(map) {
  const keys = new Set();
  for (const d of map.definitions) for (const a of d.atoms) for (const o of literalOverrides(a.overridesRaw)) keys.add(o.key);
  return [...keys].sort();
}

export function expectedCell(atoms) {
  const turfs = atoms.filter(a => isTurf(a.path)), areas = atoms.filter(a => isArea(a.path));
  return {
    turf: turfs.length ? turfs.at(-1).path : '/turf',
    area: areas.length ? areas.at(-1).path : '/area',
    underlays: Math.max(0, turfs.length - 1),
    turfOverrides: turfs.length ? literalOverrides(turfs.at(-1).overridesRaw) : [],
    contents: [...atoms.filter(a => !isTurf(a.path) && !isArea(a.path) && !isMob(a.path)), ...atoms.filter(a => isMob(a.path))]
      .map(a => ({ type: a.path, overrides: literalOverrides(a.overridesRaw) })),
  };
}

export function worldSize(map) {
  return { maxx: map.world.maxX, maxy: map.world.maxY, maxz: map.world.maxZ };
}

/**
 * Compare a parsed map with a native dump ({maxx,maxy,maxz,keys,cells:[[turf,area,underlays,
 * turfVars,[[type,vars],...]],...]} in x-fastest, then y, then z order). Returns a bounded list of
 * disagreements plus counts. `maxReported` caps the listed differences, never the count.
 */
export function compareWorld(map, native, { maxReported = 50 } = {}) {
  const size = worldSize(map), differences = []; let count = 0, checkedOverrides = 0;
  const report = (where, field, expected, actual) => { count++; if (differences.length < maxReported) differences.push({ ...where, field, expected, actual }); };
  for (const k of ['maxx', 'maxy', 'maxz']) if (size[k] !== native[k]) report({}, k, size[k], native[k]);
  if (count) return { agree: false, cells: 0, checkedOverrides, differences, differenceCount: count };
  const keyIndex = new Map(native.keys.map((k, i) => [k, i]));
  let i = 0;
  for (let z = 1; z <= size.maxz; z++) for (let y = 1; y <= size.maxy; y++) for (let x = 1; x <= size.maxx; x++, i++) {
    const at = { x, y, z }, cell = map.inspectCell(x, y, z), want = expectedCell(cell ? cell.atoms : []), got = native.cells[i];
    if (!got) { report(at, 'cell', 'present', 'missing'); continue; }
    const [turf, area, underlays, turfVars, contents] = got;
    if (turf !== want.turf) report(at, 'turf', want.turf, turf);
    if (area !== want.area) report(at, 'area', want.area, area);
    if (underlays !== want.underlays) report(at, 'underlays', want.underlays, underlays);
    for (const o of want.turfOverrides) { checkedOverrides++; const v = turfVars[keyIndex.get(o.key)]; if (v !== o.expected) report(at, `turf.${o.key}`, o.expected, v); }
    const gotTypes = contents.map(c => c[0]), wantTypes = want.contents.map(c => c.type);
    if (gotTypes.join('\n') !== wantTypes.join('\n')) { report(at, 'contents', wantTypes, gotTypes); continue; }
    want.contents.forEach((c, j) => { for (const o of c.overrides) { checkedOverrides++; const v = contents[j][1][keyIndex.get(o.key)]; if (v !== o.expected) report(at, `contents[${j}].${o.key}`, o.expected, v); } });
  }
  if (native.cells.length !== i) report({}, 'cellCount', i, native.cells.length);
  return { agree: count === 0, cells: i, checkedOverrides, differences, differenceCount: count };
}

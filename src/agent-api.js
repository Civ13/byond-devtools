/**
 * Local agent API: the byond-devtools core as a set of named tools with JSON inputs and outputs,
 * bound to one project root. Transport-free; src/mcp.js serves it over MCP stdio.
 *
 * Every map path is project-relative and read with the same realpath containment as the CLI.
 * Read-only by default. The one tool that writes a map, `map_edit` with apply: true, is refused
 * unless the API was created with allowWrite, and then goes through edit-project's base-hash,
 * stale-stack, verification and optional contract checks. Only ingame_render runs game code, and
 * only when the API was created with allowGame (temp folder, -safe, 127.0.0.1, no saves); no tool
 * touches a live server. PNGs asked for with file: true go to outDir, never into the project.
 * The type tree comes from DreamMaker -o (or a saved tree) once per session.
 */
import { readProjectFile, readProjectBytes } from './project.js';
import { parseDmm } from './dmm.js';
import { resolveVar, lintMap } from './typetree.js';
import { overrideAssignments } from './world.js';
import { loadRenderer, renderMap } from './render-project.js';
import { editMapFile } from './edit-project.js';
import { loadDiff, renderDiff, loadIconDiff } from './diff-project.js';
import { diffRegion } from './diff.js';
import { extractPrefab, placePrefab, validatePrefab } from './prefab.js';
import { findGenerators, GENERATOR_PROFILES } from './generators.js';
import { checkContract, validateContract, needsTypes, densityResolver } from './contracts.js';
import { compileProject } from './devrun-project.js';
import { decodeDmi, DIR_ORDER, frameSequence } from './dmi.js';
import { decodePng, encodePng, encodeApng } from './png.js';
import { recordIngame, PROFILES, validateDump, loadDumpIcons } from './ingame.js';
import { renderIngame } from './ingame-render.js';
import { parseBackground, withBackground, scaleImage, drawBoxes, frameSheet, sideBySide, compareImages, ImageInputError } from './image.js';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';

export class ToolInputError extends Error { constructor(message) { super(message); this.name = 'ToolInputError'; } }

const int = { type: 'integer', minimum: 1 };
const region = { x1: int, y1: int, x2: int, y2: int, z: int };
const mapArg = { map: { type: 'string', description: 'Project-relative .dmm path, e.g. maps/nomads/nomads_gaia.dmm' } };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const KINDS = ['area', 'turf', 'obj', 'mob'];
const DIRS = { south: 2, north: 1, east: 4, west: 8, southeast: 6, southwest: 10, northeast: 5, northwest: 9 };
const strings = { type: 'array', items: { type: 'string' }, maxItems: 100 };
/** Output options shared by every tool that returns a PNG. */
const output = {
  scale: { type: 'integer', minimum: 1, maximum: 8, description: 'Nearest-neighbour upscale (default 1)' },
  background: { type: 'string', description: '#rrggbb, #rrggbbaa or transparent (default)' },
  inline: { type: 'boolean', description: 'Return the PNG in the reply (default true)' },
  file: { type: 'boolean', description: 'Also write the PNG to the server\'s temp output folder and return its path (usable as a compare reference)' },
};
const filters = {
  kinds: { type: 'array', items: { enum: KINDS } }, exclude_kinds: { type: 'array', items: { enum: KINDS } },
  types: { ...strings, description: 'Only these types and their subtypes' }, exclude_types: { ...strings, description: 'Never these types or subtypes' },
  filter_mode: { enum: ['hide', 'dim'], description: 'What happens to atoms the filters leave out (default hide)' },
};
const boxes = { type: 'array', maxItems: 100, description: 'Outlined tile rectangles: [{x, y, width?, height?, color?}] in map coordinates', items: { type: 'object' } };
const animateMap = { type: 'object', description: 'Animated PNG of the region: {frames: 2-60, interval_ms: 10-10000 (default 100)}; every animated icon state plays from the same start, by its own delays' };
const MAX_ANIMATION_PIXELS = 64 * 1024 * 1024;
const regionProps = { ...region, map: { type: 'string', description: 'Project-relative .dmm path for a static render' } };

/** Tool definitions: name, description, inputSchema, annotations. */
export const TOOLS = Object.freeze([
  { name: 'map_summary', description: 'World size, levels, dictionary size, diagnostics and the most used types of a map (authored source).', inputSchema: obj(mapArg, ['map']), annotations: { readOnlyHint: true } },
  { name: 'map_cell', description: 'The authored atom stack of one tile, with raw override text.', inputSchema: obj({ ...mapArg, x: int, y: int, z: int }, ['map', 'x', 'y', 'z']), annotations: { readOnlyHint: true } },
  { name: 'map_find', description: 'Tiles holding a type (optionally subtypes), paginated.', inputSchema: obj({ ...mapArg, type: { type: 'string' }, subtypes: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 10000 }, offset: { type: 'integer', minimum: 0 } }, ['map', 'type']), annotations: { readOnlyHint: true } },
  { name: 'map_render', description: 'Static PNG preview of a region (authored source + compiled type defaults, not a client screenshot). At most 64x64 tiles. Filters hide or dim atoms by kind or type; boxes outline tiles; animate makes an animated PNG.', inputSchema: obj({ ...mapArg, ...region, grid: { type: 'integer', minimum: 0 }, show_invisible: { type: 'boolean' }, ...filters, boxes, animate: animateMap, ...output }, ['map', 'x1', 'y1', 'x2', 'y2', 'z']), annotations: { readOnlyHint: true } },
  { name: 'icon_info', description: 'A DMI\'s size, states, dirs, frames and delays.', inputSchema: obj({ dmi: { type: 'string', description: 'Project-relative .dmi or .png' } }, ['dmi']), annotations: { readOnlyHint: true } },
  { name: 'icon_render', description: 'PNG of one icon state: one dir and frame, with animate an animated PNG, or with sheet a grid of every dir (rows) by frame (columns). Give dmi + state, or a type to draw its default icon, state and dir.', inputSchema: obj({ dmi: { type: 'string' }, type: { type: 'string' }, state: { type: 'string' }, dir: { enum: Object.keys(DIRS) }, frame: { type: 'integer', minimum: 1 }, movement: { type: 'boolean' }, sheet: { type: 'boolean' }, animate: { type: 'boolean', description: 'Animated PNG of the state in this dir with its own delays, rewind and loop count' }, ...output }), annotations: { readOnlyHint: true } },
  { name: 'icon_diff', description: 'Compare a .dmi with its version at a git revision (default HEAD) or with another .dmi, state by state: added, removed and changed states (size, dirs, frames, delays, pixels), and a PNG with one row per changed state: before | after | heatmap.', inputSchema: obj({ dmi: { type: 'string', description: 'Project-relative .dmi (the "after" side)' }, git_ref: { type: 'string', description: 'Revision for the "before" side (default HEAD)' }, before: { type: 'string', description: 'Another project-relative .dmi as the "before" side, instead of git_ref' }, threshold: { type: 'integer', minimum: 0, maximum: 255 }, max_rows: { type: 'integer', minimum: 1, maximum: 200, description: 'Rows in the picture (default 40)' }, ...output }, ['dmi']), annotations: { readOnlyHint: true } },
  { name: 'image_compare', description: 'Compare a PNG reference with a candidate (another PNG, or a static render of map + region). Returns differing pixel counts and bounds, and optionally a side | heatmap PNG.', inputSchema: obj({ reference: { type: 'string', description: 'Project-relative PNG, or a path this server wrote with file: true' }, candidate: { type: 'string', description: 'PNG path as for reference; omit to render map + region' }, ...regionProps, ...filters, threshold: { type: 'integer', minimum: 0, maximum: 255 }, show: { enum: ['side', 'heatmap', 'none'] }, ...output }, ['reference']), annotations: { readOnlyHint: true } },
  { name: 'ingame_render', description: 'Boot the game headless (RUNS GAME CODE in a temp folder: -safe, 127.0.0.1, no saves) and render the initialized world: runtime icons, overlays, colour matrices, planes and lighting. Needs the server started with --allow-game. Slow (a full compile and boot). At most 64x64 tiles.', inputSchema: obj({ ...region, map: { type: 'string', description: 'Optional map to select instead of the .dme\'s own' }, profile: { enum: PROFILES }, time_of_day: { type: 'string' }, boxes, ...output }, ['x1', 'y1', 'x2', 'y2', 'z']), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'dump_render', description: 'Render an appearance dump in the ingame_render format, such as Civ13\'s character_view of a live character: appearance trees, colour matrices, planes and plane masters. Icons come inline as base64 or as project-relative source paths. Screen objects (dump.screen with screen_loc) are drawn; undrawn lists clickable atoms that put no pixel on the map. At most 64x64 tiles; runs nothing.', inputSchema: obj({ dump: { type: 'object', description: '{region: [x1, y1, x2, y2, z], icon_size, appearances, icons, cells, plane_masters?, see_invisible?, screen?, view?, center?}' }, dumps: { type: 'array', maxItems: 30, items: { type: 'object' }, description: 'Several dumps (snapshots over time) instead of dump: an animated PNG, one frame each' }, interval_ms: { type: 'integer', minimum: 10, maximum: 60000, description: 'Frame time with dumps (default 1000)' }, boxes, ...output }), annotations: { readOnlyHint: true } },
  { name: 'map_lint', description: 'Unknown types and overrides of undeclared vars, from the native type tree.', inputSchema: obj(mapArg, ['map']), annotations: { readOnlyHint: true } },
  { name: 'type_info', description: 'A type\'s parent chain, source location and resolved vars from the native type tree.', inputSchema: obj({ type: { type: 'string' } }, ['type']), annotations: { readOnlyHint: true } },
  { name: 'map_diff', description: 'Changed tiles between the map and a git revision, another map, or a patch dry run; optionally a before | after | changes PNG.', inputSchema: obj({ ...mapArg, git_ref: { type: 'string' }, before: { type: 'string' }, patch: { type: 'object' }, limit: { type: 'integer', minimum: 0, maximum: 10000 }, render: { type: 'boolean' } }, ['map']), annotations: { readOnlyHint: true } },
  { name: 'map_edit', description: 'Replace tile stacks with a patch {base, edits: [{x, y, z, expect, set}]}. Dry run unless apply is true (writing needs the server started with --allow-write). An optional contract must pass on the result.', inputSchema: obj({ ...mapArg, patch: { type: 'object' }, apply: { type: 'boolean' }, contract: { type: 'object' } }, ['map', 'patch']), annotations: { destructiveHint: true, idempotentHint: false } },
  { name: 'prefab_extract', description: 'Lift a region as a prefab (JSON tile stacks). Returns the prefab; nothing is written.', inputSchema: obj({ ...mapArg, ...region, layers: { type: 'array', items: { enum: ['movable', 'turf', 'area'] } } }, ['map', 'x1', 'y1', 'x2', 'y2', 'z']), annotations: { readOnlyHint: true } },
  { name: 'prefab_place', description: 'Turn a prefab into an edit patch at x, y, z (replace or overlay). Preview with map_diff, apply with map_edit.', inputSchema: obj({ ...mapArg, prefab: { type: 'object' }, x: int, y: int, z: int, mode: { enum: ['replace', 'overlay'] } }, ['map', 'prefab', 'x', 'y', 'z']), annotations: { readOnlyHint: true } },
  { name: 'map_generators', description: 'Spawners, loot drops and landmarks in a map and the types their vars name.', inputSchema: obj({ ...mapArg, z: int, profile: { enum: Object.keys(GENERATOR_PROFILES) }, roots: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', minimum: 0, maximum: 10000 } }, ['map']), annotations: { readOnlyHint: true } },
  { name: 'project_compile', description: 'Full DreamMaker build of the project (optionally with another map selected) in a temp folder; returns errors and warnings with project-relative file:line. Runs no game code.', inputSchema: obj({ map: { type: 'string', description: 'Optional map to select instead of the .dme\'s own' } }), annotations: { readOnlyHint: true } },
  { name: 'map_check', description: 'Run a spatial contract (require/forbid/area/reachable/unreachable/enclosed rules with actor assumptions).', inputSchema: obj({ ...mapArg, contract: { type: 'object' } }, ['map', 'contract']), annotations: { readOnlyHint: true } },
]);

/** Check args against a tool's flat schema: required keys, no unknown keys, primitive types. */
function validate(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolInputError('arguments must be an object');
  const { properties, required } = tool.inputSchema;
  for (const k of required) if (args[k] === undefined) throw new ToolInputError(`${k} is required`);
  for (const [k, v] of Object.entries(args)) {
    const s = properties[k]; if (!s) throw new ToolInputError(`unknown argument ${k}`);
    if (s.type === 'integer' && (!Number.isSafeInteger(v) || v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) throw new ToolInputError(`${k} must be an integer${s.minimum !== undefined ? ` >= ${s.minimum}` : ''}${s.maximum !== undefined ? ` <= ${s.maximum}` : ''}`);
    if (s.type === 'string' && typeof v !== 'string') throw new ToolInputError(`${k} must be a string`);
    if (s.type === 'boolean' && typeof v !== 'boolean') throw new ToolInputError(`${k} must be a boolean`);
    if (s.type === 'object' && (!v || typeof v !== 'object' || Array.isArray(v))) throw new ToolInputError(`${k} must be an object`);
    if (s.type === 'array') {
      if (!Array.isArray(v)) throw new ToolInputError(`${k} must be an array`);
      if (s.maxItems !== undefined && v.length > s.maxItems) throw new ToolInputError(`${k} has more than ${s.maxItems} items`);
      for (const item of v) {
        if (s.items?.enum && !s.items.enum.includes(item)) throw new ToolInputError(`${k} items must be one of ${s.items.enum.join(', ')}`);
        if (s.items?.type === 'string' && typeof item !== 'string') throw new ToolInputError(`${k} items must be strings`);
        if (s.items?.type === 'object' && (!item || typeof item !== 'object' || Array.isArray(item))) throw new ToolInputError(`${k} items must be objects`);
      }
    }
    if (s.enum && !s.enum.includes(v)) throw new ToolInputError(`${k} must be one of ${s.enum.join(', ')}`);
  }
}

/**
 * Create the API for one project. Options: root, dme, byond (bin folder) or tree (saved
 * DreamMaker -o XML), allowWrite, allowGame (ingame_render may boot the game), outDir (where
 * file: true PNGs go; default a byond-devtools-mcp folder under the OS temp folder). Returns {tools, call(name, args) -> {json, png?}}.
 */
export function createAgentApi({ root, dme, byond, tree, allowWrite = false, allowGame = false, outDir = path.join(os.tmpdir(), 'byond-devtools-mcp') }) {
  if (!root) throw new Error('root is required');
  const outRoot = path.resolve(outDir);
  /** Apply background, boxes and scale; return {png?, image}. Boxes are tile rects relative to the region. */
  async function finish(img, opts, ctx = {}) { const out = prepare(img, opts, ctx); return emit(encodePng(out, { text: ctx.comment ? { Comment: ctx.comment } : {} }), out, opts); }
  /** Animated PNG from equally sized frames; delaysMs per frame, plays 0 = forever. */
  async function finishAnimation(imgs, delaysMs, plays, opts, ctx = {}) {
    const frames = imgs.map(img => prepare(img, opts, ctx)), first = frames[0];
    if (first.width * first.height * frames.length > MAX_ANIMATION_PIXELS) throw new ToolInputError('Animation pixel limit exceeded; use fewer frames, a smaller region or a lower scale');
    const png = encodeApng(frames.map(f => f.rgba), { width: first.width, height: first.height, delaysMs, plays, text: ctx.comment ? { Comment: ctx.comment } : {} });
    const out = await emit(png, first, opts);
    out.image.animation = { frames: frames.length, delaysMs, plays, format: 'apng' };
    return out;
  }
  async function emit(png, img, opts) {
    const image = { width: img.width, height: img.height, scale: opts.scale ?? 1 };
    if (opts.file) {
      await mkdir(outRoot, { recursive: true });
      image.file = path.join(outRoot, createHash('sha256').update(png).digest('hex').slice(0, 24) + '.png');
      await writeFile(image.file, png);
    }
    return { png: opts.inline === false ? undefined : png, image };
  }
  function prepare(img, opts, { region: reg, iconSize } = {}) {
    let out = withBackground(img, parseBackground(opts.background));
    if (opts.boxes?.length) {
      if (!reg) throw new ToolInputError('boxes need a map region');
      out = { ...out, rgba: Uint8Array.from(out.rgba) };
      drawBoxes(out, opts.boxes.map((b, n) => {
        if (!b || typeof b !== 'object' || !Number.isSafeInteger(b.x) || !Number.isSafeInteger(b.y)) throw new ToolInputError(`boxes[${n}] needs integer x and y`);
        const w = b.width ?? 1, h = b.height ?? 1;
        if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1) throw new ToolInputError(`boxes[${n}] width and height must be positive integers`);
        const color = parseBackground(b.color ?? '#ff00ff') ?? [255, 0, 255, 255];
        return { left: (b.x - reg.x1) * iconSize, top: (reg.y2 - (b.y + h - 1)) * iconSize, width: w * iconSize, height: h * iconSize, color };
      }));
    }
    try { out = scaleImage(out, opts.scale ?? 1); } catch (e) { if (e instanceof ImageInputError) throw new ToolInputError(e.message); throw e; }
    return out;
  }
  /** A PNG from the project (contained) or from this server's output folder. */
  async function readImage(file) {
    if (typeof file !== 'string' || !file) throw new ToolInputError('image path must be a string');
    let bytes;
    if (path.isAbsolute(file)) {
      const real = await realpath(file).catch(() => null), base = await realpath(outRoot).catch(() => outRoot);
      if (!real || path.relative(base, real).startsWith('..') || path.isAbsolute(path.relative(base, real))) throw new ToolInputError('Absolute image paths must be files this server wrote (file: true)');
      bytes = await readFile(real);
    } else bytes = (await readProjectBytes(root, file)).data;
    try { const p = decodePng(bytes); return { width: p.width, height: p.height, rgba: p.rgba }; } catch (e) { throw new ToolInputError(`${file}: ${e.message}`); }
  }
  const filterOf = a => (a.kinds || a.exclude_kinds || a.types || a.exclude_types || a.filter_mode)
    ? { kinds: a.kinds, excludeKinds: a.exclude_kinds, types: a.types, excludeTypes: a.exclude_types, mode: a.filter_mode ?? 'hide' } : null;
  const checkRegion = ({ x1, y1, x2, y2 }) => { if (x2 < x1 || y2 < y1 || (x2 - x1 + 1) * (y2 - y1 + 1) > 64 * 64) throw new ToolInputError('Region must be non-empty and at most 64x64 tiles'); };
  async function staticRender(a, timeDs = null) {
    checkRegion(a);
    const r = await renderer(); const out = await renderMap(r, { root, map: a.map, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, z: a.z, grid: a.grid ?? 0, showInvisible: !!a.show_invisible, filter: filterOf(a), timeDs, maxTiles: 64 * 64 });
    return { out, iconSize: r.iconSize };
  }
  let rendererPromise = null;
  const renderer = () => {
    if (!dme) throw new ToolInputError('This tool needs the native type tree: start the server with --dme and --byond or --tree');
    if (!byond && !tree) throw new ToolInputError('This tool needs --byond BIN or --tree FILE');
    rendererPromise ??= loadRenderer({ root, dme, binDir: byond, treeFile: tree }).catch(e => { rendererPromise = null; throw e; });
    return rendererPromise;
  };
  const readMap = async map => { const input = await readProjectFile(root, map); return { input, parsed: parseDmm(input.text.replace(/^﻿/, '')) }; };
  const provenance = (map, input, extra = {}) => ({ map, sha256: input.sha256, truthLayer: 'authored-source', ...extra });
  const contractCheck = async contract => {
    validateContract(contract);
    let density = null;
    if (needsTypes(contract)) { const r = await renderer(); density = densityResolver(r.tree, r.project.sourceLine, r.defines); }
    return text => { const out = checkContract(parseDmm(text), contract, { isDense: density?.isDense }); if (density) out.unresolvedDensity = [...density.unresolved].sort().slice(0, 50); return out; };
  };

  const handlers = {
    async map_summary({ map }) { const { input, parsed } = await readMap(map); const s = parsed.summary(); return { provenance: provenance(map, input), data: { ...s, types: [...s.types].sort((a, b) => b.instances - a.instances).slice(0, 50), typeCount: s.types.length } }; },
    async map_cell({ map, x, y, z }) { const { input, parsed } = await readMap(map); const c = parsed.inspectCell(x, y, z); return { provenance: provenance(map, input), data: c ? { x, y, z, key: c.key, atoms: c.atoms.map(a => ({ path: a.path, overrides: a.overridesRaw, raw: a.raw.trim() })) } : { x, y, z, hole: true } }; },
    async map_find({ map, type, subtypes = false, limit = 100, offset = 0 }) { const { input, parsed } = await readMap(map); return { provenance: provenance(map, input), data: parsed.find(type, { includeSubtypes: subtypes, limit, offset }) }; },
    async map_render(a) {
      if (a.animate) {
        const { frames, interval_ms: interval = 100, ...rest } = a.animate;
        if (Object.keys(rest).length) throw new ToolInputError(`animate takes frames and interval_ms, not ${Object.keys(rest).join(', ')}`);
        if (!Number.isSafeInteger(frames) || frames < 2 || frames > 60) throw new ToolInputError('animate.frames must be an integer from 2 to 60');
        if (!Number.isSafeInteger(interval) || interval < 10 || interval > 10000) throw new ToolInputError('animate.interval_ms must be an integer from 10 to 10000');
        const renders = [];
        for (let i = 0; i < frames; i++) renders.push(await staticRender(a, (i * interval) / 100));
        const { out, iconSize } = renders[0];
        const { png, image } = await finishAnimation(renders.map(r => r.out.result), renders.map(() => interval), 0, a, { comment: `byond-devtools static render (animated); ${out.result.truthLayer}; not a client screenshot`, region: a, iconSize });
        return { provenance: out.provenance, data: { width: out.result.width, height: out.result.height, drawn: out.result.drawn, holes: out.result.holes, diagnostics: out.result.diagnostics, image }, png };
      }
      const { out, iconSize } = await staticRender(a);
      const { png, image } = await finish(out.result, a, { comment: `byond-devtools static render; ${out.result.truthLayer}; not a client screenshot`, region: a, iconSize });
      return { provenance: out.provenance, data: { width: out.result.width, height: out.result.height, drawn: out.result.drawn, holes: out.result.holes, diagnostics: out.result.diagnostics, image }, png };
    },
    async icon_info({ dmi }) {
      const input = await readProjectBytes(root, dmi), icon = decodeDmi(input.data, { plainPng: true });
      return { provenance: { dmi, sha256: input.sha256, truthLayer: 'authored-asset' }, data: { version: icon.version, width: icon.width, height: icon.height, sheet: icon.sheet, plain: icon.plain,
        states: icon.states.map(s => ({ name: s.name, dirs: s.dirs, frames: s.frames, delay: s.delay, movement: s.movement, loop: s.loop, rewind: s.rewind })) } };
    },
    async icon_diff(a) {
      let d;
      try { d = await loadIconDiff({ root, dmi: a.dmi, gitRef: a.before ? undefined : (a.git_ref || 'HEAD'), before: a.before, threshold: a.threshold ?? 0, maxRows: a.max_rows ?? 40 }); }
      catch (e) { throw new ToolInputError(e.message); }
      const out = d.image ? await finish(d.image, a, { comment: `byond-devtools icon diff: before | after | heatmap; ${d.after.dmi}` }) : { png: undefined, image: null };
      return { provenance: { before: d.before, after: d.after, truthLayer: 'authored-asset' }, data: { ...d.summary, states: d.states, image: out.image }, png: out.png };
    },
    async icon_render(a) {
      if (!a.dmi === !a.type) throw new ToolInputError('Give exactly one of dmi or type');
      let icon, file, sha256, state = a.state, dir = a.dir ? DIRS[a.dir] : undefined;
      if (a.type) {
        const r = await renderer(); if (!r.tree.has(a.type)) throw new ToolInputError(`Unknown type ${a.type}`);
        const ap = r.appearance({ path: a.type, overridesRaw: '' });
        if (!ap.icon || typeof ap.icon !== 'object' || !ap.icon.resource) throw new ToolInputError(`${a.type} has no icon file`);
        await r.loadIcon(ap.icon.resource); const found = r.icons.get(ap.icon.resource);
        if (!found) throw new ToolInputError(`Icon ${ap.icon.resource} could not be read`);
        ({ dmi: icon, file, sha256 } = found); state ??= String(ap.icon_state ?? ''); dir ??= typeof ap.dir === 'number' ? ap.dir : 2;
      } else {
        const input = await readProjectBytes(root, a.dmi); file = a.dmi; sha256 = input.sha256;
        try { icon = decodeDmi(input.data, { plainPng: true }); } catch (e) { throw new ToolInputError(`${a.dmi}: ${e.message}`); }
      }
      state ??= ''; dir ??= 2;
      const st = icon.findState(state, { movement: !!a.movement });
      if (!st) throw new ToolInputError(`No ${a.movement ? 'movement ' : ''}state "${state}" in ${file}; states: ${icon.states.slice(0, 40).map(s => JSON.stringify(s.name)).join(', ')}`);
      if (a.animate && a.sheet) throw new ToolInputError('Give animate or sheet, not both');
      let img;
      if (a.animate) {
        const seq = frameSequence(st);
        const frames = seq.map(f => ({ width: icon.width, height: icon.height, rgba: icon.frame(st, dir, f.frame, { display: true }) }));
        const { png, image } = await finishAnimation(frames, seq.map(f => f.delayDs * 100), st.loop > 0 ? st.loop : 0, a, { comment: `byond-devtools icon animation; ${file}:${state}` });
        const dirNames = Object.fromEntries(Object.entries(DIRS).map(([k, v]) => [v, k]));
        return { provenance: { dmi: file, sha256, type: a.type ?? null, truthLayer: 'authored-asset' },
          data: { state, movement: st.movement, dirs: st.dirs, frames: st.frames, delay: st.delay, loop: st.loop, rewind: st.rewind, dir: dirNames[dir] ?? dir, sequence: seq, image }, png };
      }
      if (a.sheet) {
        const frames = [];
        for (const d of DIR_ORDER.slice(0, st.dirs)) for (let f = 1; f <= st.frames; f++) frames.push(icon.frame(st, d, f));
        img = frameSheet(frames, { width: icon.width, height: icon.height, columns: st.frames });
      } else {
        const px = icon.frame(st, dir, a.frame ?? 1, { display: true });
        if (!px) throw new ToolInputError(`State "${state}" has no frame ${a.frame ?? 1}`);
        img = { width: icon.width, height: icon.height, rgba: px };
      }
      const { png, image } = await finish(img, a, { comment: `byond-devtools icon render; ${file}:${state}` });
      const dirNames = Object.fromEntries(Object.entries(DIRS).map(([k, v]) => [v, k]));
      return { provenance: { dmi: file, sha256, type: a.type ?? null, truthLayer: 'authored-asset' },
        data: { state, movement: st.movement, dirs: st.dirs, frames: st.frames, delay: st.delay, loop: st.loop, rewind: st.rewind,
          ...(a.sheet ? { rows: DIR_ORDER.slice(0, st.dirs).map(d => dirNames[d]), columns: st.frames } : { dir: dirNames[dir] ?? dir, frame: a.frame ?? 1 }), image }, png };
    },
    async image_compare(a) {
      const ref = await readImage(a.reference);
      let cand, candidate;
      if (a.candidate) { if (a.map) throw new ToolInputError('Give candidate or map + region, not both'); cand = await readImage(a.candidate); candidate = { file: a.candidate }; }
      else {
        for (const k of ['map', 'x1', 'y1', 'x2', 'y2', 'z']) if (a[k] === undefined) throw new ToolInputError(`${k} is required when candidate is omitted`);
        const { out } = await staticRender(a); cand = out.result; candidate = { render: out.provenance, diagnostics: out.result.diagnostics };
      }
      const show = a.show ?? 'side';
      const cmp = compareImages(ref, cand, { threshold: a.threshold ?? 0, heatmap: show !== 'none' });
      let png, image;
      if (show !== 'none') {
        const panels = show === 'side' ? sideBySide([withBackground(ref, [0, 0, 0, 255]), withBackground(cand, [0, 0, 0, 255]), cmp.heatmap]) : cmp.heatmap;
        ({ png, image } = await finish(panels, { ...a, boxes: undefined }, { comment: 'byond-devtools image compare' }));
        if (show === 'side') image.panels = ['reference', 'candidate', 'heatmap'];
      }
      const { heatmap, ...stats } = cmp;
      return { provenance: { reference: a.reference, candidate, threshold: a.threshold ?? 0, truthLayer: 'pixels' }, data: { ...stats, identical: stats.differentPixels === 0, image: image ?? null }, png };
    },
    async ingame_render(a) {
      if (!allowGame) throw new ToolInputError('In-game renders run game code: start the server with --allow-game to enable ingame_render');
      if (!dme || !byond) throw new ToolInputError('ingame_render needs the server started with --dme and --byond');
      checkRegion(a);
      const run = await recordIngame({ root, dme, map: a.map, binDir: byond, profile: a.profile ?? 'default', region: { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, z: a.z }, timeOfDay: a.time_of_day });
      if (run.status !== 'ok') throw Object.assign(new Error(`in-game run ${run.status}${run.failure ? `: ${run.failure}` : ''}`), { name: 'IngameRunError', postcondition: { compiler: run.compiler, runtime: run.runtime?.slice(-4000) } });
      const r = renderIngame(run.dump, await loadDumpIcons(run.dump, root));
      const { png, image } = await finish(r, a, { comment: `byond-devtools in-game render; ${r.truthLayer}; composed by byond-devtools, not a client screenshot`, region: a, iconSize: run.dump.icon_size });
      return { provenance: { ...run.dump.provenance, byond: run.dump.byond, region: run.dump.region, timeOfDay: run.dump.time_of_day, seconds: run.seconds, runtimeErrors: run.runtimeErrors },
        data: { width: r.width, height: r.height, drawn: r.drawn, diagnostics: r.diagnostics, image,
          notModelled: ['filters (incl. client ambient occlusion)', 'maptext', 'vis_contents', 'animation past frame 1', 'KEEP_TOGETHER groups', 'client.color and screen objects'] }, png };
    },
    async dump_render(a) {
      if (!a.dump === !a.dumps?.length) throw new ToolInputError('Give exactly one of dump or dumps');
      const dumps = a.dumps ?? [a.dump];
      try { for (const d of dumps) validateDump(d); } catch (e) { throw new ToolInputError(e.message); }
      const dump = dumps[0], [x1, y1, x2, y2] = dump.region;
      const renders = [];
      for (const d of dumps) renders.push(renderIngame(d, await loadDumpIcons(d, root)));
      const r = renders[0], comment = `byond-devtools dump render; ${r.truthLayer}; composed by byond-devtools, not a client screenshot`;
      let out;
      if (renders.length > 1) {
        // Snapshots of a moving character can differ in size at the map edge: pad to the largest.
        const width = Math.max(...renders.map(f => f.width)), height = Math.max(...renders.map(f => f.height));
        const fit = f => { if (f.width === width && f.height === height) return f; const rgba = new Uint8Array(width * height * 4); for (let y = 0; y < f.height; y++) rgba.set(f.rgba.subarray(y * f.width * 4, (y + 1) * f.width * 4), y * width * 4); return { width, height, rgba }; };
        const interval = a.interval_ms ?? 1000;
        out = await finishAnimation(renders.map(fit), renders.map(() => interval), 0, a, { comment });
      } else out = await finish(r, a, { comment, region: { x1, y1, x2, y2 }, iconSize: dump.icon_size });
      return { provenance: { ...(dump.provenance || {}), byond: dump.byond ?? null, region: dump.region, timeOfDay: dump.time_of_day ?? null, truthLayer: dump.provenance?.truthLayer ?? 'live-appearance-dump' },
        data: { width: r.width, height: r.height, drawn: r.drawn, diagnostics: r.diagnostics, undrawn: r.undrawn, undrawnCount: r.undrawnCount, image: out.image,
          frames: renders.length > 1 ? renders.map(f => ({ drawn: f.drawn, undrawnCount: f.undrawnCount })) : undefined,
          notModelled: ['filters (incl. client ambient occlusion)', 'maptext', 'vis_contents', 'animation past frame 1', 'KEEP_TOGETHER groups', 'client.color and secondary-map screen objects'] }, png: out.png };
    },
    async map_lint({ map }) {
      const r = await renderer(), { input, parsed } = await readMap(map);
      const lint = lintMap(parsed, r.tree, { overrideKeys: raw => overrideAssignments(raw).map(o => o.key) });
      return { provenance: provenance(map, input, { truthLayer: 'native-type-tree' }), data: { ...lint, parserDiagnostics: parsed.diagnostics } };
    },
    async type_info({ type }) {
      const r = await renderer(); if (!r.tree.has(type)) throw new ToolInputError(`Unknown type ${type}`);
      const chain = r.tree.chain(type), names = new Set(); for (const p of chain) for (const v of r.tree.get(p)?.vars || []) names.add(v);
      const vars = {}; for (const n of [...names].sort()) { const e = r.tree.lookupVar(type, n); vars[n] = { ...resolveVar(e, r.project.sourceLine, r.defines), declaredIn: e.from, at: e.file ? `${e.file}:${e.line}` : null }; }
      return { provenance: { dme, truthLayer: 'native-type-tree' }, data: { type, chain, file: r.tree.get(type)?.file ?? null, procs: r.tree.get(type)?.procNames ?? [], vars } };
    },
    async map_diff({ map, git_ref, before, patch, limit = 1000, render = false }) {
      const loaded = await loadDiff({ root, map, gitRef: git_ref, before, patch, limit });
      let png = null, image = null;
      if (render) { const reg = diffRegion(loaded.diff, {}); if (reg) { const out = await renderDiff(await renderer(), { root, loaded, region: reg }); png = out.png; image = { region: out.region, outlined: out.outlined, panels: ['before', 'after', 'highlight'] }; } }
      return { provenance: { before: loaded.before, after: loaded.after, truthLayer: 'authored-source' }, data: { ...loaded.diff, image }, png };
    },
    async map_edit({ map, patch, apply = false, contract }) {
      if (apply && !allowWrite) throw new ToolInputError('Writing is disabled: start the server with --allow-write to apply edits (dry runs work without it)');
      const postcondition = contract ? await contractCheck(contract) : undefined;
      const report = await editMapFile({ root, map, patch, apply, postcondition });
      return { provenance: { map: report.map, baseSha256: report.baseSha256, truthLayer: 'authored-source' }, data: report };
    },
    async prefab_extract({ map, layers, ...reg }) { const { input, parsed } = await readMap(map); return { provenance: provenance(map, input), data: extractPrefab(parsed, { ...reg, layers, source: { map, sha256: input.sha256 } }) }; },
    async prefab_place({ map, prefab, x, y, z, mode = 'replace' }) { const { input, parsed } = await readMap(map); return { provenance: provenance(map, input), data: placePrefab(parsed, validatePrefab(prefab), { x, y, z, mode, base: input.sha256 }) }; },
    async map_generators({ map, z, profile = 'default', roots, limit = 1000 }) {
      const r = await renderer(), { input, parsed } = await readMap(map);
      return { provenance: provenance(map, input, { truthLayer: 'authored-source+native-type-tree', profile }), data: findGenerators(parsed, r.tree, r.project.sourceLine, { roots: roots ?? GENERATOR_PROFILES[profile].roots, z, limit, defines: r.defines }) };
    },
    async project_compile({ map }) {
      if (!dme || !byond) throw new ToolInputError('project_compile needs the server started with --dme and --byond');
      const r = await compileProject({ root, dme, map, binDir: byond });
      return { provenance: { dme, dmeSha256: r.dmeSha256, map: r.map, truthLayer: 'native-compiler' }, data: { ...r, diagnostics: r.diagnostics.slice(0, 500), diagnosticsTruncated: r.diagnostics.length > 500 } };
    },
    async map_check({ map, contract }) { const check = await contractCheck(contract), { input } = await readMap(map); return { provenance: provenance(map, input), data: check(input.text.replace(/^﻿/, '')) }; },
  };

  return {
    root,
    tools: TOOLS,
    async call(name, args = {}) {
      const tool = TOOLS.find(t => t.name === name);
      if (!tool) throw new ToolInputError(`Unknown tool ${name}`);
      validate(tool, args);
      return handlers[name](args);
    },
  };
}

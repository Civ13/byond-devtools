/**
 * Local agent API: the byond-devtools core as a set of named tools with JSON inputs and outputs,
 * bound to one project root. Transport-free; src/mcp.js serves it over MCP stdio.
 *
 * Every map path is project-relative and read with the same realpath containment as the CLI.
 * Read-only by default. The one tool that writes a map, `map_edit` with apply: true, is refused
 * unless the API was created with allowWrite, and then goes through edit-project's base-hash,
 * stale-stack, verification and optional contract checks. No tool runs game code or touches a
 * server; the type tree comes from DreamMaker -o (or a saved tree) once per session.
 */
import { readProjectFile } from './project.js';
import { parseDmm } from './dmm.js';
import { resolveVar, lintMap } from './typetree.js';
import { overrideAssignments } from './world.js';
import { loadRenderer, renderMap } from './render-project.js';
import { editMapFile } from './edit-project.js';
import { loadDiff, renderDiff } from './diff-project.js';
import { diffRegion } from './diff.js';
import { extractPrefab, placePrefab, validatePrefab } from './prefab.js';
import { findGenerators, GENERATOR_PROFILES } from './generators.js';
import { checkContract, validateContract, needsTypes, densityResolver } from './contracts.js';
import { compileProject } from './devrun-project.js';

export class ToolInputError extends Error { constructor(message) { super(message); this.name = 'ToolInputError'; } }

const int = { type: 'integer', minimum: 1 };
const region = { x1: int, y1: int, x2: int, y2: int, z: int };
const mapArg = { map: { type: 'string', description: 'Project-relative .dmm path, e.g. maps/nomads/nomads_gaia.dmm' } };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** Tool definitions: name, description, inputSchema, annotations. */
export const TOOLS = Object.freeze([
  { name: 'map_summary', description: 'World size, levels, dictionary size, diagnostics and the most used types of a map (authored source).', inputSchema: obj(mapArg, ['map']), annotations: { readOnlyHint: true } },
  { name: 'map_cell', description: 'The authored atom stack of one tile, with raw override text.', inputSchema: obj({ ...mapArg, x: int, y: int, z: int }, ['map', 'x', 'y', 'z']), annotations: { readOnlyHint: true } },
  { name: 'map_find', description: 'Tiles holding a type (optionally subtypes), paginated.', inputSchema: obj({ ...mapArg, type: { type: 'string' }, subtypes: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 10000 }, offset: { type: 'integer', minimum: 0 } }, ['map', 'type']), annotations: { readOnlyHint: true } },
  { name: 'map_render', description: 'Static PNG preview of a region (authored source + compiled type defaults, not a client screenshot). At most 64x64 tiles.', inputSchema: obj({ ...mapArg, ...region, grid: { type: 'integer', minimum: 0 }, show_invisible: { type: 'boolean' } }, ['map', 'x1', 'y1', 'x2', 'y2', 'z']), annotations: { readOnlyHint: true } },
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
    if (s.type === 'array' && !Array.isArray(v)) throw new ToolInputError(`${k} must be an array`);
    if (s.enum && !s.enum.includes(v)) throw new ToolInputError(`${k} must be one of ${s.enum.join(', ')}`);
  }
}

/**
 * Create the API for one project. Options: root, dme, byond (bin folder) or tree (saved
 * DreamMaker -o XML), allowWrite. Returns {tools, call(name, args) -> {json, png?}}.
 */
export function createAgentApi({ root, dme, byond, tree, allowWrite = false }) {
  if (!root) throw new Error('root is required');
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
    async map_render({ map, x1, y1, x2, y2, z, grid = 0, show_invisible = false }) {
      if ((x2 - x1 + 1) * (y2 - y1 + 1) > 64 * 64 || x2 < x1 || y2 < y1) throw new ToolInputError('Region must be non-empty and at most 64x64 tiles');
      const r = await renderer(); const out = await renderMap(r, { root, map, x1, y1, x2, y2, z, grid, showInvisible: show_invisible, maxTiles: 64 * 64 });
      return { provenance: out.provenance, data: { width: out.result.width, height: out.result.height, drawn: out.result.drawn, holes: out.result.holes, diagnostics: out.result.diagnostics }, png: out.png };
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
    tools: TOOLS,
    async call(name, args = {}) {
      const tool = TOOLS.find(t => t.name === name);
      if (!tool) throw new ToolInputError(`Unknown tool ${name}`);
      validate(tool, args);
      return handlers[name](args);
    },
  };
}

/**
 * MCP resources and prompts for the byond-devtools server. Resources: a short guide, the
 * project's maps (read as a map summary) and templates for any map, icon or type. Prompts:
 * ready-made requests for common jobs. Everything goes through the read-only agent API.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_MAPS = 1000;
const SKIP = new Set(['.git', 'node_modules', '.vscode', 'data', 'tmp']);

export const GUIDE = `# byond-devtools MCP guide

Coordinates are one-based; (1,1) is the south-west corner. Renders are static previews of the
authored source plus compiled type defaults, not client screenshots.

- Look: map_summary, map_cell, map_find; map_render for a picture (at most 64x64 tiles).
  Filter by kinds/types (hide or dim), outline tiles with boxes, animate for an APNG.
- Icons: icon_info for states, icon_render for one frame, a sheet or an animation; icon_diff to
  compare a .dmi with a git revision (before | after | heatmap per changed state).
- Types: type_info for a type's vars and source; map_lint for unknown types and vars.
- Change a map: prefab_place or your own patch, preview with map_diff (render: true), check with
  map_check, then map_edit with apply: true (needs --allow-write). A patch carries the map's
  sha256 as base and each tile's current stack as expect.
- Resize a map: map_resize (dry run first; apply with the dry run's baseSha256 as base). New
  space and holes between blocks get the fill stack; offset_x/offset_y grow it west or south.
- Compare pictures: image_compare (a PNG against a PNG or a fresh render).
- Live game: ingame_render boots the game (needs --allow-game); dump_render draws a dump a running
  game made, such as Civ13's character_view.

Resources: byond://guide, byond://map/{path} (a map summary), byond://icon/{path} (icon states),
byond://type/{path} (a type's vars, needs the type tree).
`;

export const PROMPTS = Object.freeze([
  { name: 'render_area', description: 'Render and describe an area of a map', arguments: [
    { name: 'map', description: 'Project-relative .dmm', required: true }, { name: 'x', description: 'Centre x', required: true },
    { name: 'y', description: 'Centre y', required: true }, { name: 'z', description: 'Level (default 1)' }, { name: 'radius', description: 'Tiles around the centre (default 8)' }] },
  { name: 'review_map_change', description: 'Review what changed in a map since a git revision', arguments: [
    { name: 'map', description: 'Project-relative .dmm', required: true }, { name: 'git_ref', description: 'Revision to compare with (default HEAD)' }] },
  { name: 'inspect_icon', description: 'Show an icon file\'s states and draw one', arguments: [
    { name: 'dmi', description: 'Project-relative .dmi', required: true }, { name: 'state', description: 'State to draw (default the first)' }] },
]);

function text(value) { return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300); }
function num(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${name} must be a whole number`);
  return n;
}

/** The messages for a prompt; throws RangeError on a missing or bad argument. */
export function promptMessages(name, args = {}) {
  const prompt = PROMPTS.find(p => p.name === name);
  if (!prompt) throw new RangeError(`Unknown prompt ${name}`);
  for (const a of prompt.arguments) if (a.required && (args[a.name] === undefined || args[a.name] === '')) throw new RangeError(`${a.name} is required`);
  let body;
  if (name === 'render_area') {
    const x = num(args.x, 1, 'x'), y = num(args.y, 1, 'y'), z = num(args.z, 1, 'z'), r = Math.min(31, num(args.radius, 8, 'radius'));
    body = `Call map_render on ${text(args.map)} with x1=${Math.max(1, x - r)}, y1=${Math.max(1, y - r)}, x2=${x + r}, y2=${y + r}, z=${z} and grid 1. `
      + 'Describe what is there: terrain, buildings, objects and anything that looks wrong (holes, unknown types, placeholders). '
      + 'Use map_cell on interesting tiles for exact stacks, and say which findings come from the picture and which from the data.';
  } else if (name === 'review_map_change') {
    body = `Call map_diff on ${text(args.map)} with git_ref=${text(args.git_ref || 'HEAD')} and render: true. `
      + 'Summarise the changed tiles (added and removed atoms), point out anything that looks unintended, '
      + 'and run map_lint on the map for unknown types or vars the change introduced.';
  } else {
    body = `Call icon_info on ${text(args.dmi)}, then icon_render with sheet: true for ${args.state ? `state "${text(args.state)}"` : 'its first state'}`
      + ' (and animate: true if it has several frames). Describe the states, their directions and frames, and anything that looks broken.';
  }
  return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: body } }] };
}

/** Project-relative .dmm files under root, sorted, at most MAX_MAPS. */
export async function listMaps(root) {
  const out = [];
  async function walk(dir, rel) {
    if (out.length >= MAX_MAPS) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_MAPS) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), r); }
      else if (e.isFile() && e.name.toLowerCase().endsWith('.dmm')) out.push(r);
    }
  }
  await walk(root, '');
  return out;
}

export const RESOURCE_TEMPLATES = Object.freeze([
  { uriTemplate: 'byond://map/{path}', name: 'Map summary', description: 'World size, levels and most used types of a project map', mimeType: 'application/json' },
  { uriTemplate: 'byond://icon/{path}', name: 'Icon states', description: 'A .dmi\'s size, states, dirs, frames and delays', mimeType: 'application/json' },
  { uriTemplate: 'byond://type/{path}', name: 'Type info', description: 'A type\'s parent chain, source and vars (needs the type tree)', mimeType: 'application/json' },
]);

export async function listResources(root) {
  const maps = await listMaps(root);
  return [{ uri: 'byond://guide', name: 'byond-devtools guide', description: 'How to use these tools', mimeType: 'text/markdown' },
    ...maps.map(m => ({ uri: `byond://map/${m}`, name: m, description: 'Map summary', mimeType: 'application/json' }))];
}

/** Read one resource URI through the agent API. Returns {uri, mimeType, text}. */
export async function readResource(api, uri) {
  if (uri === 'byond://guide') return { uri, mimeType: 'text/markdown', text: GUIDE };
  const m = /^byond:\/\/(map|icon|type)\/(.+)$/.exec(String(uri));
  if (!m) throw new RangeError(`Unknown resource ${uri}`);
  const target = decodeURIComponent(m[2]);
  const out = m[1] === 'map' ? await api.call('map_summary', { map: target })
    : m[1] === 'icon' ? await api.call('icon_info', { dmi: target })
    : await api.call('type_info', { type: target.startsWith('/') ? target : `/${target}` });
  return { uri, mimeType: 'application/json', text: JSON.stringify({ schemaVersion: 1, ...out }) };
}

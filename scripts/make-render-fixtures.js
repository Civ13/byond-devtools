#!/usr/bin/env node
// Generates the original icons for fixtures/render/project and, with a BYOND install, records
// its type tree and native instance values. Deterministic; re-running produces identical bytes.
//   node scripts/make-render-fixtures.js            regenerate icons
//   node scripts/make-render-fixtures.js --byond BIN   also re-record tree.xml and native-values.json
//   node scripts/make-render-fixtures.js --golden      rewrite the golden render (review the diff!)
import { writeFile, readFile } from 'node:fs/promises';
import { encodePng } from '../src/png.js';

export const ROOT = 'fixtures/render/project', DME = 'render.dme', MAP = 'maps/render.dmm';
export const TYPES = ['/turf/floor', '/turf/floor/grass', '/obj/box', '/obj/box/high', '/obj/tinted', '/obj/ghost', '/obj/broken', '/obj/tree', '/mob/man'];
export const VARS = ['icon', 'icon_state', 'dir', 'layer', 'plane', 'pixel_x', 'pixel_y', 'color', 'alpha', 'invisibility'];

/** Build a DMI from states [{name, dirs, frames, paint(x, y, dirIndex, frame) -> [r,g,b,a]}]. */
function dmi(size, states, columns = 4) {
  const icons = states.reduce((n, s) => n + s.dirs * (s.frames || 1), 0), rows = Math.ceil(icons / columns);
  const width = size * columns, height = size * rows, rgba = new Uint8Array(width * height * 4);
  let desc = `# BEGIN DMI\nversion = 4.0\n\twidth = ${size}\n\theight = ${size}\n`, n = 0;
  for (const s of states) {
    desc += `state = "${s.name}"\n\tdirs = ${s.dirs}\n\tframes = ${s.frames || 1}\n`;
    for (let f = 0; f < (s.frames || 1); f++) for (let d = 0; d < s.dirs; d++, n++) {
      const ox = (n % columns) * size, oy = Math.floor(n / columns) * size;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rgba.set(s.paint(x, y, d, f), ((oy + y) * width + ox + x) * 4);
    }
  }
  return encodePng({ width, height, rgba }, { text: { Description: desc + '# END DMI\n' } });
}
const solid = c => () => c;
const CLEAR = [0, 0, 0, 0];
// Box: a 4x4 square in the bottom-left corner, one colour per direction (S, N, E, W).
const BOX = [[220, 40, 40, 255], [230, 220, 40, 255], [40, 220, 220, 255], [220, 40, 220, 255]];
export const ICONS = {
  'icons/floor.dmi': () => dmi(8, [{ name: 'floor', dirs: 1, paint: solid([100, 100, 100, 255]) }, { name: 'grass', dirs: 1, paint: solid([40, 160, 40, 255]) }]),
  'icons/objs.dmi': () => dmi(8, [
    { name: 'box', dirs: 4, paint: (x, y, d) => x < 4 && y >= 4 ? BOX[d] : CLEAR },
    { name: 'half', dirs: 1, paint: solid([255, 255, 255, 128]) }]),
  'icons/mob.dmi': () => dmi(8, [{ name: 'man', dirs: 1, paint: (x, y) => x >= 3 && x <= 4 && y >= 1 && y <= 6 ? [40, 40, 230, 255] : CLEAR }]),
  // 16x16 on an 8px world: anchored at the tile's bottom-left, so only the bottom-left quadrant
  // (brown) lands on its own tile; the rest extends past the map edge.
  'icons/big.dmi': () => dmi(16, [{ name: 'tree', dirs: 1, paint: (x, y) => x < 8 && y >= 8 ? [120, 70, 20, 255] : [20, 90, 20, 255] }], 1),
};

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('make-render-fixtures.js')) {
  for (const [file, make] of Object.entries(ICONS)) await writeFile(`${ROOT}/${file}`, make());
  console.log('wrote', Object.keys(ICONS).length, 'icons');
  const i = process.argv.indexOf('--byond');
  if (i > 0) {
    const binDir = process.argv[i + 1];
    const { loadProjectTypes } = await import('../src/project.js');
    const { recordInstanceVars } = await import('../src/native.js');
    const p = await loadProjectTypes({ root: ROOT, dme: DME, binDir });
    if (p.compiler.errorCount) throw new Error(p.compiler.errors.join('\n'));
    await writeFile('fixtures/render/tree.xml', p.xml);
    await writeFile('fixtures/render/native-values.json', JSON.stringify(await recordInstanceVars({ root: ROOT, dme: DME, types: TYPES, vars: VARS, binDir }), null, 1) + '\n');
    console.log('recorded fixtures/render/tree.xml and native-values.json');
  }
  if (process.argv.includes('--golden')) {
    const { loadRenderer, renderMap } = await import('../src/render-project.js');
    const renderer = await loadRenderer({ root: ROOT, dme: DME, treeFile: 'fixtures/render/tree.xml' });
    const { png } = await renderMap(renderer, { root: ROOT, map: MAP });
    await writeFile('fixtures/render/golden.png', png);
    console.log('wrote fixtures/render/golden.png', (await readFile('fixtures/render/golden.png')).length, 'bytes');
  }
}

#!/usr/bin/env node
// Re-records fixtures/types/tree.xml and native-values.json with a BYOND install:
//   node scripts/record-types-fixture.js --byond BIN
import { writeFile } from 'node:fs/promises';
import { loadProjectTypes } from '../src/project.js';
import { recordInstanceVars } from '../src/native.js';
export const FIXTURE = { root: 'fixtures/types/project', dme: 'test.dme',
  types: ['/turf/floor', '/turf/floor/grass', '/obj/item', '/obj/thing', '/mob/dummy'],
  vars: ['icon', 'icon_state', 'layer', 'pixel_x', 'dir', 'name', 'alpha', 'density', 'amount', 'desc'] };
const i = process.argv.indexOf('--byond');
if (i > 0) {
  const binDir = process.argv[i + 1];
  const p = await loadProjectTypes({ root: FIXTURE.root, dme: FIXTURE.dme, binDir });
  if (p.compiler.errorCount) throw new Error(p.compiler.errors.join('\n'));
  await writeFile('fixtures/types/tree.xml', p.xml);
  await writeFile('fixtures/types/native-values.json', JSON.stringify(await recordInstanceVars({ ...FIXTURE, binDir }), null, 1) + '\n');
  console.log('recorded fixtures/types/tree.xml and native-values.json');
}

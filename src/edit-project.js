/**
 * File side of map edits: base-hash precondition, dry run, and an atomic apply.
 * The map is written only with `apply: true`, through a temp file in the same folder that is
 * flushed, re-read and hashed before it replaces the original. The original is re-hashed just
 * before the swap so a concurrent change fails the edit instead of being overwritten.
 */
import { open, readFile, rename, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { readProjectBytes } from './project.js';
import { planEdit, EditError } from './edit.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Returns {applied, map, postcondition?, baseSha256, newSha256, changes, newKeys, reusedKeys, orphanedKeys, inverse, verified}. */
export async function editMapFile({ root, map, patch, apply = false, maxEdits, postcondition }) {
  if (!patch || typeof patch.base !== 'string' || !/^[0-9a-f]{64}$/.test(patch.base)) throw new EditError('Patch must name the map\'s current sha256 as "base"');
  const input = await readProjectBytes(root, map);
  if (input.sha256 !== patch.base) throw new EditError(`Map changed since the patch was made: base ${patch.base}, file ${input.sha256}`, { actualSha256: input.sha256 });
  const bom = input.data.subarray(0, 3).equals(BOM);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? input.data.subarray(3) : input.data);
  const plan = planEdit(text, patch, maxEdits ? { maxEdits } : undefined);
  const out = Buffer.concat([bom ? BOM : Buffer.alloc(0), Buffer.from(plan.text, 'utf8')]);
  const newSha256 = sha256(out);
  const report = { applied: false, map: input.relative.split(path.sep).join('/'), baseSha256: input.sha256, newSha256,
    changes: plan.changes, newKeys: plan.newKeys, reusedKeys: plan.reusedKeys, orphanedKeys: plan.orphanedKeys,
    inverse: { base: newSha256, ...plan.inverse }, verified: plan.verified };
  // A postcondition (for example a spatial contract) sees the planned text; a failure blocks the write.
  if (postcondition) {
    report.postcondition = await postcondition(plan.text);
    if (apply && report.postcondition && report.postcondition.failed) throw new EditError(`Postcondition failed (${report.postcondition.failed} rule(s)); nothing was written`, { postcondition: report.postcondition });
  }
  if (!apply) return report;
  const file = path.join(input.projectRoot, input.relative);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.devtools-${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(tmp, 'wx');
    try { await handle.writeFile(out); await handle.sync(); } finally { await handle.close(); }
    if (sha256(await readFile(tmp)) !== newSha256) throw new EditError('Temp file did not read back as written');
    if (sha256(await readFile(file)) !== input.sha256) throw new EditError('Map changed while the edit was being written; nothing was replaced');
    await rename(tmp, file);
  } catch (error) { await rm(tmp, { force: true }); throw error; }
  if (sha256(await readFile(file)) !== newSha256) throw new EditError('Map did not read back as written after the swap');
  return { ...report, applied: true };
}

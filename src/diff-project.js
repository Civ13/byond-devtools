/**
 * File side of map diffs. Reads the "before" and "after" map text from the project (a second
 * file, a git revision, or a dry-run patch applied in memory), diffs them, and optionally renders
 * a before | after | highlight PNG with the static renderer. Never writes a map. Also the file
 * side of icon diffs (loadIconDiff).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readProjectFile, readProjectBytes } from './project.js';
import { parseDmm } from './dmm.js';
import { planEdit } from './edit.js';
import { diffMaps, diffRegion, composeDiff, regionChanges } from './diff.js';
import { renderMap } from './render-project.js';
import { encodePng } from './png.js';
import { decodeDmi } from './dmi.js';
import { diffIcons } from './icon-diff.js';

const decode = data => {
  const bom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? data.subarray(3) : data);
};

/** Read `relative` as it was at git revision `ref` (read-only `git show`, no shell). */
export function gitShow(root, relative, ref, options) {
  const bytes = gitShowBytes(root, relative, ref, options);
  if (bytes === null) throw new Error(`${relative.split(path.sep).join('/')} does not exist at ${ref}`);
  return decode(bytes);
}

/** The bytes of `relative` at git revision `ref`, or null when the file did not exist there. */
export function gitShowBytes(root, relative, ref, { maxBytes = 64 * 1024 * 1024 } = {}) {
  if (typeof ref !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]*$/.test(ref) || ref.includes('..')) throw new Error('Invalid git revision');
  const posix = relative.split(path.sep).join('/');
  const r = spawnSync('git', ['-C', root, 'show', `${ref}:./${posix}`], { maxBuffer: maxBytes, windowsHide: true });
  if (r.error) throw new Error(`git failed: ${r.error.message}`);
  if (r.status !== 0) {
    const err = String(r.stderr).trim();
    if (/does not exist in|exists on disk, but not in/.test(err)) return null;
    throw new Error(`git show ${ref}:${posix} failed: ${err}`);
  }
  return r.stdout;
}

/**
 * Compare a project .dmi with its version at git revision `gitRef` or with another project file
 * `before`, state by state (src/icon-diff.js). A file new since the revision diffs as all added.
 */
export async function loadIconDiff({ root, dmi, gitRef, before, threshold = 0, maxRows }) {
  if ((gitRef === undefined || gitRef === null) === (before === undefined || before === null)) throw new Error('Give exactly one of git_ref or before');
  const current = await readProjectBytes(root, dmi);
  const after = { source: 'file', dmi: current.relative.split(path.sep).join('/'), sha256: current.sha256 };
  let beforeBytes, beforeInfo;
  if (gitRef) { beforeBytes = gitShowBytes(current.projectRoot, current.relative, gitRef); beforeInfo = { source: 'git', ref: gitRef, existed: beforeBytes !== null }; }
  else { const b = await readProjectBytes(root, before); beforeBytes = b.data; beforeInfo = { source: 'file', dmi: b.relative.split(path.sep).join('/'), sha256: b.sha256 }; }
  const decodeIcon = (bytes, label) => { try { return decodeDmi(bytes, { plainPng: true }); } catch (e) { throw new Error(`${label}: ${e.message}`); } };
  const result = diffIcons(beforeBytes ? decodeIcon(beforeBytes, `before (${gitRef ?? before})`) : null, decodeIcon(current.data, after.dmi), { threshold, maxRows });
  return { before: beforeInfo, after, ...result };
}

/**
 * Diff a project map against `before` (project-relative file), `gitRef`, or the result of
 * dry-running `patch` on it. Returns {before, after, diff, beforeText, afterText}.
 */
export async function loadDiff({ root, map, before, gitRef, patch, limit }) {
  const sources = [before, gitRef, patch].filter(v => v !== undefined && v !== null);
  if (sources.length !== 1) throw new Error('Give exactly one of --before, --git-ref or --patch');
  const current = await readProjectBytes(root, map), currentText = decode(current.data);
  let beforeText, afterText, beforeInfo, afterInfo = { source: 'file', map: current.relative.split(path.sep).join('/'), sha256: current.sha256 };
  if (patch) {
    if (patch.base !== current.sha256) throw new Error(`Map changed since the patch was made: base ${patch.base}, file ${current.sha256}`);
    beforeText = currentText; beforeInfo = afterInfo;
    afterText = planEdit(currentText, patch).text; afterInfo = { source: 'patch (dry run, not written)' };
  } else if (gitRef) {
    beforeText = gitShow(current.projectRoot, current.relative, gitRef); beforeInfo = { source: 'git', ref: gitRef };
    afterText = currentText;
  } else {
    const b = await readProjectFile(root, before); beforeText = b.text.replace(/^\uFEFF/, ''); beforeInfo = { source: 'file', map: b.relative.split(path.sep).join('/'), sha256: b.sha256 };
    afterText = currentText;
  }
  const beforeMap = parseDmm(beforeText), afterMap = parseDmm(afterText);
  const diff = diffMaps(beforeMap, afterMap, limit === undefined ? undefined : { limit });
  return { before: beforeInfo, after: afterInfo, diff, beforeText, afterText, beforeMap, afterMap };
}

/** Render a diff of level z (default: first changed level) as a three-panel PNG. */
export async function renderDiff(renderer, { root, loaded, region, pad, maxSide }) {
  const r = region ?? diffRegion(loaded.diff, { pad, maxSide });
  if (!r) return null;
  const opts = { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, z: r.z };
  const b = await renderMap(renderer, { root, mapText: loaded.beforeText, ...opts });
  const a = await renderMap(renderer, { root, mapText: loaded.afterText, ...opts });
  const img = composeDiff(b.result, a.result, regionChanges(loaded.beforeMap, loaded.afterMap, r), r, renderer.iconSize);
  const png = encodePng(img, { text: { Comment: 'byond-devtools map diff: before | after | changed tiles; static render of authored source, not a client screenshot' } });
  return { png, region: { ...r }, width: img.width, height: img.height, outlined: img.outlined,
    diagnostics: { before: b.result.diagnostics, after: a.result.diagnostics } };
}

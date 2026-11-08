# Architecture and acceptance gates

## Shared engine, separate adapters

```
DMM source --> bounded parser --> immutable authored snapshot
                                    |          |          |
                                  CLI    VS Code UI   agent API (MCP)
DME / DM / DMI --> type tree, DMI decoder, static renderer ---+
```

The core (`src/dmm.js`) has no filesystem, network, shell, native compiler or DM
execution. `src/project.js` is a Node adapter for project-contained file access.
The CLI returns `schemaVersion: 1`, file SHA-256 and `truthLayer: authored-source`.
The DME inventory is lexical only, including inactive conditional references as
unknown. It must not be relabeled as a semantic project resolver.

## Data integrity

A dictionary key is compression, not durable object identity. Edits copy-on-write only
at selected coordinates (`src/edit.js`): an edited cell gets a reused or new key, and no
existing dictionary entry is ever changed or removed. Preserve repeated objects, atom order, overrides and
unresolved paths. Never silently deduplicate, normalize or repair them.

The parser rejects duplicate definitions, mixed key widths, undefined grid keys,
nonrectangular rows, overlapping blocks, unsafe coordinates, mismatched delimiters,
trailing junk, oversized input and excessive nesting. Missing world cells remain
holes, not invented turfs. Block dimensions and occupied cell count are distinct
from the bounding volume. Bounds must never be used to allocate a dense world
without a separate checked volume budget.

Default limits: 64 MiB text, 2 million occupied cells, 65,534 definitions, 4,096
blocks, 4,096 atoms per definition, 128 nested delimiters. Calls may lower limits,
not increase them. Search returns at most 10,000 compact coordinate/key references and reports a complete count
and pagination status. Root-contained file reads reject outside symlinks. Do not
use this as a privileged multi-user service: concurrent filesystem replacement
(TOCTOU), request isolation and authentication need separate service design.

## Coordinate model

Coordinates are one-based; `(1,1)` is southwest. Placement follows native BYOND, recorded
from DreamDaemon 516.1688 in `fixtures/native/`: the map height is the largest
`header y + rows - 1` over every block on every z level, and a block's first (north) row
lands at `height - (header y - 1)`. Header y therefore counts down from the top of the map.
For ordinary maps, where every block starts at y=1 with full height, this is the same as
bottom-up placement; all 279 Civ13 maps are ordinary in this sense. OpenDream's loader
places offset blocks bottom-up, which disagrees with BYOND for unusual offset maps.
Blocks expose their placed bounds plus the original `header`. `map.world` gives the native
world size, which can exceed the highest placed row.

## Validation ladder

1. Syntax and structural invariants (implemented subset).
2. Source-preserving no-op observation and adversarial input tests (implemented).
3. Native type tree and semantic lint (unknown types, undeclared override vars), alongside
   Civ13 maplint (implemented, `src/typetree.js`).
4. Semantic/visual edit diff (`src/diff.js`, pure; `src/diff-project.js`, I/O): stack-based
   cell comparison independent of dictionary keys, and unaffected-region equality in `edit`.
5. Native map-load agreement: stub-typed maps compiled and booted in DreamDaemon
   516.1688, compared cell by cell (implemented, `scripts/native.js`).
6. Full-game compilation and authorized isolated initialization/playtest (not run).
7. Static preview (`src/render.js`, pure; `src/render-project.js`, I/O): a golden fixture
   render with hand-checked pixels, fixture type defaults checked against DreamDaemon
   instances, and CI renders of Civ13 crops that fail on any missing icon or state. Not
   compared with a Dream Seeker screenshot; the cross-tile order of equal-layer sprites
   (south over north) is an assumption.
8. In-game render (`src/ingame.js`, `src/ingame-render.js`): truth layer
   `native-initialized-world`, a recorded fixture dump with hand-checked composition, an
   exact re-record in CI, and a compile check of the Civ13 probe.
10. VS Code preview (`vscode/`): integration suite in real VS Code Stable and Insiders on
   Linux and Windows; read-only (no edit or save path).
9. Copy-on-write edits (`src/edit.js`): base-hash and expected-stack preconditions, re-parse
   verification of every cell, mapmerge2 byte stability and maplint on the whole Civ13
   corpus, and native load agreement of an edited fixture.

Static authored layout, initialized runtime world and persistent saved world must
always be separate truth layers. A static preview does not show saved buildings or
prove native movement/lighting/constructor behavior.

## Agent contract

Implemented in `src/agent-api.js` (tools) and `src/mcp.js` (MCP stdio transport), with
contracts as postconditions (`src/contracts.js`) and prefabs placed as ordinary patches.
Observation: open a pinned snapshot; summary; inspect cell/region; find by exact type
or subtype; render bounded coordinate-labelled crops; analyze routes with explicit
actor assumptions. Editing: a patch declares base hash, expected old contents,
allowed paths, coordinate bounds, maximum counts and postconditions. Preview and
validate before apply; stale snapshots fail atomically; re-read and preserve inverse
patches. Source comments and strings are untrusted data, never instructions.

## IDE integration, planned

Prefer a companion VS Code extension and existing DM language services over a fork
of VS Code. Run stable API integration tests against Stable and Insiders separately.
Keep the compiler/runtime separately installed and project-version-pinned. Debugger
hooks, native ABI compatibility and workspace trust require their own test matrix.
No licensing decision is implied by these architecture options.

CLI JSON output is preflight-bounded to 16 MiB using a conservative worst-case
string escaping estimate. Inspect individual cells for atom details; search
results never replicate shared override bodies.

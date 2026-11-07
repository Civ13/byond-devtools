# Initial verification

Executed in a Linux cloud workspace, Node.js v24.22.1, on 2026-11-07.

- `npm test`: 34/34 tests passed, no skips.
- `npm run check`: all four source files passed Node syntax checks.
- Actual Gaia source inspected from Civ13/Civ13 commit
  `21f0473a047c3cbd9831b107a276049a4f708dc3`, path
  `maps/nomads/nomads_gaia.dmm`, source Git blob
  `52ea621a3d10855a3ef3447d2028e17e2af34803`.
- Parsed 350,000 cells, bounds (1,1,1) through (500,350,2), 255 dictionary
  definitions, 99 distinct placed type paths.
- The downloaded test copy had one added trailing newline from transfer; semantics
  match the source. The map is not included in this repository. Do not interpret
  its local SHA-256 as the upstream byte identity.
- Synthetic tests cover equivalent full-plane and TGM column orientation, offset
  blocks, duplicate objects and aliases, frozen snapshots, search pagination,
  escaped values, comments, invalid/overlapping/undefined data, safe-integer
  overflow, resource limits, root containment, symlink escape, UTF-8 validation,
  CLI errors/provenance and a generated 350,000-cell workload.

Not run: native BYOND compilation/round-trip, DMI rendering, GUI tests, Windows or
VS Code Stable/Insiders tests, runtime/gameplay/persistence acceptance. There is
no serializer or edit operation, so this proves no-op observation only, not an
edit-save round trip. CI has not yet been configured; commands above were local.

Single local Gaia timing sample (not an editor benchmark): parser 28.7 ms, summary
110.1 ms, process RSS 57.3 MiB. Hardware/runtime/cache state was not controlled;
do not interpret this as a performance guarantee. Input source remained identical.

Pinned Civ13 DME lexical inventory returned 1,462 includes; conditional activation
remains unknown. Gaia subtype query found 141 mob-spawner cells and correctly
returned one bounded result with a truncation flag.

Focused review found and fixed output amplification by shared overrides and a
multiline-string include false positive. Added regression tests; search now
returns compact coordinate/key references, and CLI JSON has a conservative 16 MiB
preflight budget. Summary counts are aggregated by dictionary-key occupancy.

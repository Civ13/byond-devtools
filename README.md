# BYOND Devtools

An early development toolkit for trustworthy BYOND map observation and, later,
editing from a shared human/agent model. This repository starts with a **read-only
DMM inspection core and CLI**, not a finished visual editor or IDE.

## Working now

- Dependency-free ECMAScript modules on Node.js 22+.
- Bounded DMM/TGM syntax parsing: dictionary, ordered atom stacks, opaque variable
  override text, one-based coordinates, multiple/offset blocks, multiple z levels.
- Source-preserving inspection: original input text is retained; no serialization,
  normalization, evaluation, mutation, network access or game process control.
- JSON summaries, exact-cell inspection and paginated type/subtype search.
- Snapshot objects/arrays are frozen, and internal lookup maps are private.
- Project-relative, realpath-contained UTF-8 file reads, SHA-256 provenance, and a
  deliberately lexical DME include inventory.
- Synthetic tests, a TGM fixture, and a CI corpus job over every Civ13 map. No game
  assets are vendored.

## Quick start

No npm install is necessary. Run:

```sh
npm test
npm run check
node src/cli.js summary --root . --map fixtures/tiny.dmm
node src/cli.js cell --root . --map fixtures/tiny.dmm --x 1 --y 2 --z 1
node src/cli.js find --root . --map fixtures/tiny.dmm --type /obj --subtypes --limit 10
```

For an existing Civ13 checkout (paths with spaces must be quoted):

```sh
node src/cli.js summary --root /path/to/Civ13 --map maps/nomads/nomads_gaia.dmm --dme civ13.dme
node src/cli.js project --root /path/to/Civ13 --dme civ13.dme
```

The same commands work on Windows with the checkout's Windows path. CI runs the
tests on Ubuntu and Windows with Node 22 and 24, and parses every map in a
shallow Civ13 checkout on both (`npm run corpus -- --root PATH`). Output is JSON; errors use stderr and
exit status 1. The CLI never writes maps.

## What this does NOT prove

Passing the parser is not full-game compilation or playability validation. Overrides
remain raw DM expressions, never evaluated. No inheritance, active conditional
includes, DMI sprite rendering, lighting, smoothing, pathfinding, runtime state or
persistent saves are resolved. The `--dme` option binds the file hash but does not
resolve its type environment. Unknown paths are retained, not silently removed.

Sparse/offset blocks are placed the way BYOND 516 places them (header y counts down
from the map top, see [architecture](docs/architecture.md)); missing cells are holes
that BYOND fills with `/turf` in `/area`. Source spans use JavaScript UTF-16 code-unit offsets, **not byte offsets**.
Files must be valid UTF-8. CLI hashes describe exact disk bytes; parser `source`
is decoded text. Neither is a native binary `.sav` representation.

The conservative syntax profile accepts ASCII identifier paths and alphabetic
keys of uniform width (1–8 characters). The default 65,534-definition cap is a
protective implementation limit, not a promise of native compatibility. It rejects
unsupported constructs instead of repairing them. Comments inside opaque override
expressions are balanced but not interpreted; comments between an atom's prefix
and type path are currently rejected. See [architecture](docs/architecture.md).

## Roadmap

1. Strict read-only inspection, provenance and source-preserving observation fixtures (current).
2. Project/type resolution through an independently tested DM language-service
   adapter; DMI decoding and coordinate-linked static rendering.
3. Read-only VS Code custom editor, installed/tested separately in Stable/Insiders.
4. One copy-on-write edit transaction with old-value preconditions, bounded edits,
   semantic/visual diff, inverse patch and verified unchanged regions.
5. Prefabs, generator-aware tools, spatial contracts and local agent API/MCP.
6. Authorized native compiler/debugger/playtest integration, distinct from static
   validation. No live-server or persistence actions by default.

## Native BYOND agreement

`scripts/native.js` compiles a map against generated stub types with a separately
installed DreamMaker, boots it headless in DreamDaemon (`-safe`), and compares every cell
(turf, area, underlay count, contents order and literal override values) with the
parser. Recorded rules: the last turf wins and earlier turfs become underlays, objs enter
contents before mobs, six-digit hex colors are stored lower case and white becomes null,
and a tile with two areas fails to compile (reported as a `multiple-areas` diagnostic).

```sh
node scripts/native.js check --byond /path/to/byond/bin fixtures/native/*.dmm
node scripts/native.js corpus --byond /path/to/byond/bin --root /path/to/Civ13
```

This is map-load agreement only. It runs no game code, so it does not prove that a
map works with Civ13's real types.

## Licensing and third-party material

Licensed under AGPL-3.0 (see LICENSE), matching Civ13. The implementation and fixtures
are original. No SpacemanDMM, StrongDMM, FastDMM2, mapmerge2 source, Civ13 map, or BYOND
binary is bundled; CI downloads the pinned BYOND build separately and checks its sha256.

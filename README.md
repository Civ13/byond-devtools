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
- Synthetic tests plus an opt-in real-map smoke test. No game assets are vendored.

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

The same commands work on Windows with the checkout's Windows path. Windows
execution is not yet independently tested. Output is JSON; errors use stderr and
exit status 1. The CLI never writes maps.

## What this does NOT prove

Passing the parser is not BYOND compilation or playability validation. Overrides
remain raw DM expressions, never evaluated. No inheritance, active conditional
includes, DMI sprite rendering, lighting, smoothing, pathfinding, runtime state or
persistent saves are resolved. The `--dme` option binds the file hash but does not
resolve its type environment. Unknown paths are retained, not silently removed.

Sparse/offset blocks are supported as authored fragments; world completeness is
not asserted. Rows are north-first within each block, with `(x,y,z)` its southwest
origin. Source spans use JavaScript UTF-16 code-unit offsets, **not byte offsets**.
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

## Licensing and third-party material

The implementation and fixtures here are original. No SpacemanDMM, StrongDMM,
FastDMM2, mapmerge2 source, Civ13 map, or BYOND binary is bundled. No public license
is selected yet; all rights are reserved pending the project's licensing decision.
This is not a declaration that upstream dependencies can be used without their
licenses. In particular, mapmerge2 identifies AGPL-3.0 origins and other likely
components use GPL-family licenses. Review licensing before incorporating them.

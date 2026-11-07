# BYOND Devtools

An early development toolkit for trustworthy BYOND map observation and, later,
editing from a shared human/agent model. It is a **DMM inspection, preview and safe-edit
core with a CLI**, not a finished visual editor or IDE.

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
exit status 1. Only `edit --apply` writes a map (see below).

## What this does NOT prove

Passing the parser is not full-game compilation or playability validation. Overrides
remain raw DM expressions, never evaluated. No inheritance, active conditional
includes, lighting, smoothing, runtime overlays, pathfinding, runtime state or
persistent saves are resolved; the static preview shows authored source plus type defaults. The `--dme` option binds the file hash but does not
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

1. Strict read-only inspection, provenance and source-preserving observation fixtures (done).
2. Native type tree, DMI decoding and coordinate-linked static rendering (done).
3. Read-only VS Code custom editor, installed/tested separately in Stable/Insiders.
4. One copy-on-write edit transaction with old-value preconditions, bounded edits,
   inverse patch and verified unchanged regions (done; visual diff to follow).
5. Prefabs, generator-aware tools, spatial contracts and local agent API/MCP.
6. Authorized native compiler/debugger/playtest integration, distinct from static
   validation. No live-server or persistence actions by default.

## Native type tree and lint

`types` and `lint` read the project's real compiled type tree from your own installed
DreamMaker (`-o`). The compiler runs on a one-line probe `.dme` in a temporary directory
that includes the project's `.dme`, so its `.rsc` lands there, not in your checkout.
A saved tree (`DreamMaker -o civ13.dme > tree.xml`) can be passed with `--tree`.

```sh
node src/cli.js types --root /path/to/Civ13 --dme civ13.dme --byond /path/to/byond/bin
node src/cli.js types --root /path/to/Civ13 --dme civ13.dme --byond BIN --type /obj/structure/closet
node src/cli.js lint  --root /path/to/Civ13 --dme civ13.dme --byond BIN --map maps/1943/berlin.dmm
```

DreamMaker's printed values are not evaluated (operators are dropped: `2 + 0.1` prints
`20.1`, `4|1` prints `41`). Each value is therefore resolved from its declaring source
line: a plain literal, a `#define` for one, or `+ - * /` arithmetic over those in 32-bit
floats. Anything else (`NORTH|EAST`, `\improper` text, proc calls) is reported as
unresolved with its source text. Fixture values are checked against instances created
in DreamDaemon. On Civ13 every `icon`, `icon_state`, `layer` and `plane` of all 11,289
atom types resolves. `lint` exits 3 when it finds unknown types or overrides of undeclared
vars. It complements Civ13's `scripts/maplint.py`, which checks tile structure.

## DMI icons

`src/png.js` and `src/dmi.js` are an original, dependency-free PNG and DMI decoder: all
non-interlaced colour types and bit depths, `tRNS` transparency, every row filter, and
the `Description` metadata (states, dirs, frames, delays, movement states). Interlaced
PNGs and malformed metadata are rejected with an error.

```sh
node src/cli.js icon --root /path/to/Civ13 --dmi icons/obj/closet.dmi
```

Pixels are checked against DreamDaemon's `icon.GetPixel`: every pixel of 15 fixtures
(one per colour type and depth), and a 24,660-pixel sample over all 384 Civ13 icons, with
zero differences. Recorded lookup rules: a duplicated state name uses the first state; a
movement lookup with no movement state, a direction the state lacks, or a frame past
its count returns nothing. The renderer's display fallback (`{display: true}`) is not yet
checked natively.

## Static map preview

`render` draws a bounded region of a map as a PNG from the authored map and the native
type tree, with icons decoded from the checkout. It is a preview of authored source plus
compiled type defaults, **not a client screenshot**.

```sh
node src/cli.js render --root /path/to/Civ13 --dme civ13.dme --byond BIN \
  --map maps/nomads/nomads_gaia.dmm --z 2 --x1 400 --y1 160 --x2 463 --y2 223 --grid 16 --out gaia.png
```

- Writes only the `--out` PNG, refuses to overwrite it without `--force`, and renders at
  most 128x128 tiles and 16 Mpx. Icon files are read inside `--root` only.
- Draw order: plane, layer, then south rows over north rows, then the tile's native
  contents order (turfs, objs, mobs). Icons anchor at the tile's bottom-left and use
  `icon_state`, `dir`, `pixel_x/y/w/z`, hex `color` and `alpha` (frame 1).
- Map overrides apply when they are plain values; type defaults use the same resolver as
  `types`. Fixture defaults are checked against DreamDaemon instance values.
- Not modelled: `New()`/`Initialize()` changes, runtime overlays and smoothing, lighting,
  animation past frame 1, filters, transforms, colour matrices, `see_invisible`.
- Everything not drawn exactly is counted in the JSON report: `unknown-type` and
  `missing-icon` draw a magenta/black placeholder, `missing-state` draws nothing (as in
  game), `invisible-skipped` (`--show-invisible` draws them), and `approximate-var` when a
  render var is an expression the resolver cannot prove. `--areas` also draws area icons.

## In-game render

`ingame` shows what the map looks like after the game has run: icons changed in
`New()`/`Initialize()`, smoothing, runtime overlays and underlays, colour matrices,
transforms, planes, plane masters and lighting. It **runs game code**: it compiles the
project's `.dme` with a probe appended (in a temp folder; the checkout is not written),
boots it in DreamDaemon with `-safe` on 127.0.0.1 with no saves and only `config/`
copied in, waits until the round is playing and lighting has settled, records the final
appearance of every atom in the region, and shuts down. Never point it at a live server.

```sh
node src/cli.js ingame --root /path/to/Civ13 --dme civ13.dme --byond BIN --profile civ13 \
  --z 2 --x1 400 --y1 160 --x2 431 --y2 191 --time-of-day Midday --save-dump gaia.json --out gaia-ingame.png
node src/cli.js ingame --root . --dump gaia.json --out again.png --force   # re-render without booting
```

- Profiles say when a game is ready: `default` (plain worlds) and `civ13` (starts the
  round like an admin's start-now, waits for lighting creation and its update queue, builds
  the HUD's plane masters, turns webhooks and Tor checks off). `--map` swaps another map
  into the `.dme`'s `BEGIN/END_SELECTED_MAP` block.
- The image is composed by byond-devtools from the recorded appearances, not taken from a
  client: planes in order, plane masters (colour matrix over the whole plane surface,
  then their blend mode), layers, south over north, underlays/self/overlays with
  inherited dir, colour, alpha, offsets and transform, blend modes, and `see_invisible`
  of a living player.
- Not modelled, counted in the report: filters (including the client's ambient-occlusion
  shadow), maptext, `vis_contents`, animation past frame 1, `KEEP_TOGETHER` groups,
  `client.color` and screen objects.

## Safe map edits

`edit` replaces whole tile stacks at given coordinates. It is a dry run unless `--apply` is
passed. A patch is JSON:

```json
{ "base": "<sha256 of the map file>",
  "bounds": { "x1": 10, "y1": 10, "x2": 20, "y2": 20, "z": 1 },
  "edits": [ { "x": 12, "y": 14, "z": 1,
               "expect": ["/turf/floor/dirt", "/area/caribbean/nomads/forest"],
               "set": ["/obj/structure/table{dir = 4}", "/turf/floor/dirt", "/area/caribbean/nomads/forest"] } ] }
```

```sh
node src/cli.js edit --root /path/to/Civ13 --map maps/x.dmm --patch patch.json                  # dry run
node src/cli.js edit --root /path/to/Civ13 --map maps/x.dmm --patch patch.json --apply --inverse-out undo.json
```

- Preconditions: the file's sha256 must equal `base`, and each cell's current stack must
  equal `expect` (whitespace outside quotes is ignored). Otherwise nothing is written.
- Only the edited grid keys change, plus new dictionary entries for new stacks. New entries
  take the lowest free key and go in key order, in the file's own DMM or TGM style and line
  endings; an existing identical stack is reused. Unused entries are kept and reported as
  `orphanedKeys`. When every key of the current width is taken the edit is refused, since
  widening keys would rewrite the whole grid.
- Overrides must be `name = value` pairs. A tile with two areas is refused (DreamMaker
  rejects it). Cells outside the existing blocks cannot be added.
- The output is re-parsed: the world size, every old dictionary entry and every untouched
  cell must be identical, and edited cells must hold the new stacks.
- `--apply` writes a temp file beside the map, flushes and re-hashes it, re-hashes the
  original to catch concurrent changes, then renames it over the map. A UTF-8 BOM is kept.
- The inverse patch (`base` = the new hash) restores every cell. It is not byte-for-byte:
  the new dictionary entries stay, unused.

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

# BYOND Devtools

A dependency-free toolkit for trustworthy BYOND map work, shared by people and agents:
inspection, a native type tree, static and in-game rendering, safe copy-on-write edits,
diffs, prefabs, generator-aware inspection, spatial contracts, an agent API/MCP server and
native compile/playtest capture, plus a VS Code map editor. Every layer says what
it was checked against (see [verification](docs/verification.md)).

## Install

- **VS Code:** install [BYOND Map Editor](https://marketplace.visualstudio.com/items?itemName=civ13.byond-devtools-vscode)
  from the Marketplace (search "BYOND Map Editor", formerly "BYOND Map Preview", in the Extensions panel), then set
  `byondDevtools.byondBin` to your BYOND `bin` folder. The `.vsix` is also attached to each
  [GitHub release](https://github.com/Civ13/byond-devtools/releases).
- **CLI:** clone this repository and run `node src/cli.js` with Node.js 22+. There is
  nothing to install.

Current release: [v0.4.0](https://github.com/Civ13/byond-devtools/releases/tag/v0.4.0): the VS Code editor compares a map
with a git revision (changed tiles outlined, Next change) and opens a tile's definition in the text;
the MCP server gains `dump_render` (live views such as Civ13's `character_view`, with screen
objects, snapshots over time and a list of clickable atoms that draw nothing), `icon_diff`,
resources and prompts, and the CLI gains `icon-diff` for sprite review. v0.3.0 added kind toggles, type
highlighting, animated states, icon renders, animated PNGs, image comparison and in-game renders
(see [Agent API (MCP)](#agent-api-mcp)).

Next, v0.5.0 (on `main`, not yet tagged): [map resize](#resize-a-map) in the CLI (`resize`), MCP
(`map_resize`) and VS Code (**BYOND: Resize map**).

## Core parser

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
persistent saves are resolved by the parser; the static preview shows authored source plus type defaults, and the `ingame` render (below) is the view after runtime changes and lighting. The `--dme` option binds the file hash but does not
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

## Roadmap (complete)

All phases are merged; v0.1.0 released them, v0.2.0 added map editing, v0.3.0 render options and v0.4.0 map compare, live views and sprite review:

1. Strict read-only inspection, provenance and source-preserving observation fixtures (done).
2. Native type tree, DMI decoding and coordinate-linked static rendering (done).
3. VS Code custom editor, tested in Stable and Insiders on Linux and Windows (done, `vscode/`; editing since v0.2.0).
4. One copy-on-write edit transaction with old-value preconditions, bounded edits,
   inverse patch and verified unchanged regions, plus a semantic and visual diff (done).
5. Prefabs, generator-aware tools, spatial contracts and a local agent API/MCP server (done;
   icon, animated, comparison and in-game render tools in v0.3.0).
6. Authorized native compiler, runtime-error and profiler capture, and local playtests,
   distinct from static validation; no live-server or persistence actions (done).

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
  `client.color` and screen objects on secondary maps.
- A dump may carry `screen` (`[appearance, screen_loc]` pairs from `client.screen`) with `view`
  (client.view) and `center`: screen objects are placed by `screen_loc` (numbers, WEST/EAST/NORTH/
  SOUTH/CENTER with offsets, `:pixel` offsets, `a to b` ranges) and sorted into the same planes.
- The result lists `undrawn`: visible, clickable movables (`mouse_opacity` not 0) whose whole
  appearance tree put no pixel on the map, so an object a player can interact with but cannot
  see shows up as a finding.

## VS Code map editor

`vscode/` is a custom editor for `.dmm` files: rendered views with the static renderer,
tile inspection and diagnostics, and editing (place, erase, stamp and move objects, edit a
tile's stack and var overrides, undo/redo). Every change is a whole-stack edit planned by
`src/edit.js`, and Save writes one patch through `src/edit-project.js` (base sha256,
expected stacks, verification, atomic replace), so a map changed on disk is never overwritten. CI runs its integration suite inside real VS Code
Stable and Insiders on Linux and Windows. It is published on the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=civ13.byond-devtools-vscode)
as `civ13.byond-devtools-vscode`. See [vscode/README.md](vscode/README.md).

Releasing: bump `vscode/package.json`'s version, merge, then push a matching tag `vX.Y.Z`.
The Release workflow runs the tests, publishes a GitHub release with the `.vsix` and, with
the `VSCE_PAT` secret set, publishes to the Marketplace.

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
  rejects it). Cells outside the existing blocks cannot be added; use `resize` for that.
- The output is re-parsed: the world size, every old dictionary entry and every untouched
  cell must be identical, and edited cells must hold the new stacks.
- `--apply` writes a temp file beside the map, flushes and re-hashes it, re-hashes the
  original to catch concurrent changes, then renames it over the map. A UTF-8 BOM is kept.
- The inverse patch (`base` = the new hash) restores every cell. It is not byte-for-byte:
  the new dictionary entries stay, unused.

## Resize a map

`resize` changes a map's size, adds or removes levels, and fills holes between grid blocks.
It is a dry run unless `--apply` is passed.

```sh
node src/cli.js resize --root /path/to/Civ13 --map maps/x.dmm --max-x 120 --max-y 100 --fill "/turf/floor/dirt,/area/caribbean/nomads"
node src/cli.js resize --root /path/to/Civ13 --map maps/x.dmm --max-x 120 --offset-x 20 --fill "..." --base <sha256> --apply
```

- Unset axes keep their size. `--offset-x`/`--offset-y` move the existing tiles, so a
  positive offset grows the map west or south. New space and holes get the `--fill` stack
  (one turf and exactly one area); tiles moved past the new edge are cropped.
- The dictionary is kept byte for byte. The fill reuses an identical existing entry, or takes
  the lowest free key in key order. The grid is rewritten as complete blocks in the map's own
  style (one block per level, or one column per block for TGM) with its line endings, so a
  resize to the same size is byte-identical. Unused entries are kept and reported.
- The output is re-parsed and every tile is checked: kept tiles hold their old stacks at the
  moved coordinates, all others hold the fill. `--apply` writes atomically as `edit` does,
  and `--base` refuses a map that changed since the dry run. Each axis is at most 1000.

## Map diff

`diff` compares a map with another file, a git revision, or the result of a patch dry run.
Cells are compared by atom stack, not dictionary key, so a map that mapmerge2 re-keyed has no
changes. Each changed cell lists the atoms removed and added (as multisets); `reordered` means
the same atoms in a new order, and `added`/`removed` mean a hole on the other side.

```sh
node src/cli.js diff --root /path/to/Civ13 --map maps/x.dmm --git-ref HEAD
node src/cli.js diff --root /path/to/Civ13 --map maps/x.dmm --patch patch.json \
  --dme civ13.dme --byond BIN --out diff.png      # before | after | changed tiles
```

- Counts, per-level bounds and per-type totals are complete; the cell list stops at `--limit`
  (default 10,000) and says `truncated`.
- `--out` renders the changed area (bounding box plus `--pad` tiles, at most 64 a side, or an
  explicit `--x1..--y2 --z`) twice with the static renderer and writes three panels: before,
  after, and after with unchanged tiles dimmed and changed tiles outlined (yellow modified,
  blue reordered, green added, red removed).
- `--git-ref` runs `git show REF:path` without a shell; revisions with `..` or a leading
  `-` are refused. A patch diff never writes the map.

## Prefabs

A prefab is a rectangle of tile stacks lifted from a map as JSON, with atom text kept as
authored. Placing one never writes the map: it makes an ordinary `edit` patch whose `expect`
stacks are the target's current tiles, so it gets the same base-hash and stale-stack checks,
and can be previewed with `diff --patch` first.

```sh
node src/cli.js prefab-extract --root R --map maps/a.dmm --x1 8 --y1 260 --x2 19 --y2 270 --z 1 \
  --layers movable,turf --out house.json
node src/cli.js prefab-place --root R --map maps/b.dmm --prefab house.json --x 410 --y 170 --z 2 --out patch.json
node src/cli.js diff --root R --map maps/b.dmm --patch patch.json --dme civ13.dme --byond BIN --out preview.png
node src/cli.js edit --root R --map maps/b.dmm --patch patch.json --apply --inverse-out undo.json
```

- `--layers` picks what each tile keeps: `movable` (objs and mobs), `turf`, `area`.
- `replace` (default) puts the prefab's stack on each tile, keeping the tile's own turf or
  area where the prefab cell has none. `overlay` adds the prefab's movables on top of what is
  there; a prefab turf or area still replaces the tile's.
- Tiles whose result is unchanged are skipped, so placing a prefab twice is a no-op. Missing
  prefab cells leave the tile alone. The prefab lists its `types`; run `lint` after applying
  when it came from another project. Rotation is not offered: `dir` values would need
  per-type knowledge to turn correctly.

## Generators

`generators` lists the map atoms that make other content when the world starts: spawners,
loot drops, landmarks and (profile `civ13`) vehicle auto-assemblers. The static preview only
shows their markers, so the report says what each one will produce, read from its vars:

```sh
node src/cli.js generators --root R --map maps/nomads/nomads_gaia.dmm --dme civ13.dme --byond BIN --profile civ13
node src/cli.js generators ... --out gens.png --x1 420 --y1 300 --x2 470 --y2 340 --z 2   # markers outlined
```

- An atom is a generator when its type is a subtype of a profile root (`--roots` overrides).
- For each generator type: instance count, `spawns` (each var whose source line or map
  override is a type path or a `list(...)` of type paths, with pickweight weights and whether
  each type exists), literal `settings` such as `max_number` or `max_range`, `unresolved`
  expressions, and the init procs (`New`, `Initialize`, ...) its type chain defines.
- Multi-line `list(` values are read across lines. Spawn targets come from source text, not
  from running code, so whether the generator really uses a var is not proven.
- `--out` renders the region with invisible atoms shown and outlines generator tiles in cyan.

## Spatial contracts

A contract is a JSON list of checks a map region must pass. `check` runs it and exits 3 on any
failure; `edit --contract` runs it on the edited text and refuses `--apply` when it would fail,
so an agent's edit cannot quietly wall off a spawn or leak a sealed room.

```json
{ "kind": "byond-devtools-contract", "schemaVersion": 1,
  "actors": { "human": { "dense": true, "blocking": { "paths": ["/turf/floor/beach/water/deep"] },
                         "passable": { "paths": ["/obj/structure/simple_door"] } } },
  "rules": [
    { "id": "spawn", "type": "require", "region": { "x1": 10, "y1": 10, "x2": 20, "y2": 20, "z": 1 },
      "match": { "paths": ["/obj/effect/landmark"] }, "min": 1, "max": 4 },
    { "id": "road", "type": "reachable", "from": { "x": 443, "y": 326, "z": 2 }, "to": { "x": 225, "y": 326, "z": 2 }, "actor": "human" },
    { "id": "vault", "type": "enclosed", "seed": { "x": 15, "y": 15, "z": 1 }, "region": { "x1": 12, "y1": 12, "x2": 18, "y2": 18, "z": 1 }, "actor": "human" } ] }
```

```sh
node src/cli.js check --root R --map maps/x.dmm --contract c.json --dme civ13.dme --byond BIN
node src/cli.js edit  --root R --map maps/x.dmm --patch p.json --contract c.json --dme civ13.dme --byond BIN --apply
```

- Rules: `require` (count of matching atoms in `[min, max]`), `forbid`, `area` (every tile's
  area matches), `reachable`, `unreachable`, `enclosed` (a walk from `seed` never leaves the
  region). `match` is `{paths, subtypes}`; subtypes count by default.
- Actors make route assumptions explicit: `blocking` paths, `dense: true` (type default or map
  override `density`, from the native type tree; unprovable densities block and are listed),
  `passable` paths that win over both (doors the actor opens), `diagonal` (corners cannot be
  cut, as with BYOND steps), `maxSteps`. Holes block. Routes stay on one z level.
- Failures carry evidence: counts and up to 20 example tiles, the route found (or that an
  endpoint is blocked and by what), and for a leaking room the first tile outside and the way out.
- A static walk over authored tiles: `Bump()`, `CanPass()`, door locks, runtime spawns and
  stairs are not modelled. On Gaia a 242-step walk across z2 checks in under 2 s.

## Agent API (MCP)

`src/mcp.js` serves the same core as tools over the Model Context Protocol (stdio), for one
project root, so an agent can inspect, render, diff, place prefabs, check contracts and edit
maps without shelling out to the CLI.

```sh
node src/mcp.js --root /path/to/Civ13 --dme civ13.dme --byond /path/to/byond/bin            # read-only
node src/mcp.js --root /path/to/Civ13 --dme civ13.dme --byond /path/to/byond/bin --allow-write
node src/mcp.js --root /path/to/Civ13 --dme civ13.dme --byond /path/to/byond/bin --allow-game    # adds ingame_render
claude mcp add byond-map -- node /path/to/byond-devtools/src/mcp.js --root /path/to/Civ13 --dme civ13.dme --byond BIN
```

Or in a project's `.mcp.json`:

```json
{ "mcpServers": { "byond-map": { "command": "node",
    "args": ["D:/GitHub/byond-devtools/src/mcp.js", "--root", "D:/GitHub/Civ13", "--dme", "civ13.dme",
             "--byond", "C:/Program Files (x86)/BYOND/bin"] } } }
```

- Tools: `map_summary`, `map_cell`, `map_find`, `map_render` (PNG image, at most 64x64 tiles),
  `map_lint`, `type_info`, `map_diff` (optionally rendered), `map_edit`, `prefab_extract`,
  `map_resize`, `prefab_place`, `map_generators`, `map_check`, `project_compile`, `icon_info`, `icon_render`,
  `icon_diff`, `image_compare`, `ingame_render` and `dump_render`. Inputs are validated against each tool's schema; unknown
  arguments are refused. Failures come back as tool errors the model can read.
- Every PNG tool takes `scale` (1-8, nearest neighbour), `background` (`#rrggbb[aa]` or
  `transparent`), `inline` (false leaves the image out of the reply) and `file` (true writes it to
  a `byond-devtools-mcp` folder under the OS temp folder and returns the path, never into the
  project). `map_render` also filters atoms by `kinds`/`exclude_kinds` and `types`/`exclude_types`
  (a type and its subtypes), hiding or dimming the rest (`filter_mode`), and outlines tiles with
  `boxes: [{x, y, width?, height?, color?}]`.
- `icon_render` draws one state, dir and frame of a `.dmi` (or a type's default icon), or with
  `sheet: true` every dir (rows) by frame (columns). `image_compare` compares a reference PNG
  (project-relative, or a `file: true` output) with another PNG or a fresh static render and
  returns the differing pixel count, bounds and max/mean delta over a `threshold`, with a
  reference | candidate | heatmap image.
- `icon_diff` compares a `.dmi` with its version at a git revision (default `HEAD`) or with another
  `.dmi`, state by state (added, removed, changed size, dirs, frames, delays or pixels), with one
  before | after | heatmap row per changed state. It is the `icon-diff` CLI for agents.
- Animated PNGs (APNG; viewers without APNG show frame 1): `icon_render` with `animate: true`
  plays one state in one dir with its own delays, `rewind` and `loop` count; `map_render` with
  `animate: {frames: 2-60, interval_ms}` renders the region at each interval, every animated
  state starting together and stepping by its own delays. `ingame_render` stays a single frame.
- `ingame_render` is the CLI's `ingame` render over MCP: it compiles and boots the game headless
  in a temp folder (`-safe`, 127.0.0.1, no saves) and composes the initialized world. It runs game
  code, so it is refused unless the server was started with `--allow-game`.
- `dump_render` draws an appearance dump in the same format without booting anything, such as a
  live Civ13 character's view (`character_view`). Its icons are inline base64 (runtime icons) or
  project-relative `source` paths read from `--root`; a missing one is a `missing-icon`
  diagnostic. With `dumps` (snapshots over time) instead of `dump` it returns an animated PNG,
  one frame per dump every `interval_ms`. The CLI does the same with
  `ingame --dump FILE.json[,FILE2.json...] --out FILE.png [--interval-ms N]`.
- Read-only by default. `map_edit` with `apply: true` needs `--allow-write`, and then still
  requires the patch's base sha256 and expected stacks, verifies the result, and refuses the
  write if an optional `contract` fails. Read-only tools are annotated `readOnlyHint`.
- Map paths are project-relative with realpath containment, as in the CLI. The type tree is
  built once per server (restart it after changing DM code). Only `ingame_render` runs game code.
- Resources: `byond://guide` (a short how-to), every project map as `byond://map/{path}` (its
  summary), and templates for `byond://icon/{path}` (states) and `byond://type/{path}` (vars).
  Prompts: `render_area`, `review_map_change` and `inspect_icon` set up those jobs for the model.
- The transport-free API is `createAgentApi()` in `src/agent-api.js`.

## Sprite review

`node src/cli.js icon-diff --before old.dmi --after new.dmi --out review.png` compares two versions
of a DMI state by state: added, removed and changed states (size, dirs, frames, delays, pixels).
The PNG has one row per changed state: before | after | heatmap. It exits 3 when anything changed
(`none` stands for a missing side). Civ13 runs it on pull requests that touch `icons/`.

## Compile and playtest

These run your installed BYOND, distinct from the static checks above. Both work in a fresh
temporary folder from a probe `.dme` that includes the checkout by absolute path, so nothing is
written to the checkout.

```sh
node src/cli.js compile  --root /path/to/Civ13 --dme civ13.dme --byond BIN [--map maps/x.dmm]
node src/cli.js playtest --root /path/to/Civ13 --dme civ13.dme --byond BIN --minutes 20 --profile-procs --follow
```

- `compile` runs DreamMaker only (no game code) and reports every error and warning with a
  project-relative `file:line`, the warning code (`unused_var`, ...) and the `.dmb` size; exit
  3 on errors. `--map` selects another map. Civ13 builds in about 10 s on a cloud runner.
- `playtest` **runs the game**: DreamDaemon `-safe`, bound to 127.0.0.1, `-invisible`, with only
  `config/` copied in and no save data, so it cannot reach a live server or its persistence. It
  prints `byond://127.0.0.1:PORT` to join with Dream Seeker and stops `--minutes` (default 30)
  after the world finishes loading, on Ctrl+C, or when the world shuts down.
- The playtest probe compiles with `DEBUG`, so runtime errors carry their source line. They come
  back grouped by message and location with counts, `src`, `usr` and the call stack.
  `--profile-procs` adds BYOND's proc profiler (top procs by total time); a heartbeat records
  CPU, map CPU and player count every 30 s.
- There is no step debugger: BYOND has no debugger protocol to attach to, so the integration
  is compiler diagnostics, runtime-error capture and the proc profiler.
- The VS Code extension has **BYOND: Compile project** and **BYOND: Start local playtest**,
  which put compile errors and runtime errors in the Problems panel. The MCP server offers
  `project_compile`; it never starts a playtest.

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

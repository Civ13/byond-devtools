# BYOND Map Editor (VS Code)

A custom editor for BYOND `.dmm` maps, built on
[byond-devtools](https://github.com/Civ13/byond-devtools). Install it from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=civ13.byond-devtools-vscode).

- Open a map, then run **BYOND: Open BYOND Map Editor** (or right-click the file, or
  "Reopen Editor With..."). The text editor stays the default for `.dmm` files.
- Pick a z level, the bottom-left tile and a view size (16, 32 or 64 tiles), then Render.
- The image is the static preview (authored source plus compiled type defaults), not a
  client screenshot. The report lists everything not drawn exactly.
- **show** turfs, objs, mobs and areas toggles which kinds are drawn. **highlight type** dims
  everything except that type and its subtypes (e.g. `/obj/structure/door`). **animate** plays
  animated icon states (8 frames, 200 ms each, every state stepping by its own delays); editing
  works the same while it plays.
- **compare with** a git revision (default `HEAD`; `master` or `origin/master` work too) dims
  unchanged tiles and outlines changed ones: yellow modified, blue reordered, green added, red
  removed. Unsaved edits count as changes. **Next change** centres the view on each changed tile
  in turn and selects it.
- **Show in text** (next to a selected tile's key) opens the `.dmm` beside the editor at that key's
  definition.
- **BYOND: Compare icon with git revision** (right-click a `.dmi`, or the editor title bar) shows
  which states were added, removed or changed since a revision (default `HEAD`) and draws each
  changed state as before | after | heatmap, every dir down and every frame across.

Editing:

- **Select**: click a tile to see its stack. Change a type path, add or remove var overrides
  (names are suggested from the type tree), reorder, remove or add atoms, then **Apply**.
  **Move** on an object or mob, then click another tile, moves it there. **Brush** loads an
  atom into the Place tool; **Use as stamp** copies the whole stack for the Stamp tool.
- **Place**: click or drag to put the brush type on tiles. Objects and mobs go on top of the
  tile's objects; a turf replaces the tile's turfs; an area replaces its area.
- **Erase**: click or drag to remove the top object or mob from tiles (turfs and areas stay).
- **Stamp**: click or drag to replace whole tiles with the copied stack.
- Undo and redo with Ctrl+Z / Ctrl+Y (or the buttons); each click or drag is one step.
  With the type tree loaded, a path the project does not define is refused.
- **Save** (Ctrl+S) writes one safe-edit patch from the file as it was opened or last saved:
  only edited tiles change, untouched cells keep their bytes, the result is re-parsed and
  verified, and the file is replaced atomically. If the file changed on disk in the
  meantime (git pull, mapmerge2), Save refuses and nothing is written; use
  **File: Revert File** to load the new version. A clean editor reloads it by itself.
  Save As is not offered: save, then copy the file.
- **BYOND: Resize map** (right-click a `.dmm`, or the editor title bar) asks for the new
  size (width x height x levels), an offset that moves the existing tiles (to grow west or
  south) and the stack for new tiles, shows what is kept, filled and cropped, then rewrites the
  file atomically. Holes between grid blocks are filled too. Save or revert unsaved edits
  first; an open editor reloads the resized map.

Other commands:

- **BYOND: Compile project** builds the `.dme` with DreamMaker in a temporary folder and
  puts every error and warning in the Problems panel (nothing is written to your checkout).
- **BYOND: Start local playtest** asks first, then compiles and runs the game on this computer
  (temporary folder, `-safe`, 127.0.0.1 only, no saves) for you to join with Dream Seeker. The
  "BYOND Playtest" output shows the world log; Cancel stops the world. Runtime errors land in
  the Problems panel at their source line. It stops by itself after `byondDevtools.playtestMinutes`.

Settings:

- `byondDevtools.byondBin`: your BYOND `bin` folder. The project's type tree is read with
  `DreamMaker -o` from a temporary folder, so nothing is written to your checkout.
- `byondDevtools.typeTree`: a saved type tree instead (`DreamMaker -o civ13.dme > tree.xml`).
- `byondDevtools.dme`: the project `.dme`, if the folder root has more than one.
- `byondDevtools.playtestMinutes`: how long a playtest runs (default 30).

Development: `npm ci`, then `npm test` runs the integration suite in a downloaded VS Code
(`VSCODE_VERSION=insiders npm test` for Insiders; Linux needs `xvfb-run -a`).
`npm run package` bundles the core and writes `byond-map-preview.vsix`; install it with
"Extensions: Install from VSIX...". Pushing a `vX.Y.Z` tag publishes a GitHub release with
the .vsix, and also publishes to the Visual Studio Marketplace (Microsoft Entra sign-in through
variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`) and Open VSX
(secret `OVSX_PAT`) when those are set. See the main README's release notes.

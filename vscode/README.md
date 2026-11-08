# BYOND Map Preview (VS Code)

A read-only custom editor for BYOND `.dmm` maps, built on
[byond-devtools](https://github.com/Civ13/byond-devtools). Install it from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=civ13.byond-devtools-vscode).

- Open a map, then run **BYOND: Open BYOND Map Preview** (or right-click the file, or
  "Reopen Editor With..."). The text editor stays the default for `.dmm` files.
- Pick a z level, the bottom-left tile and a view size (16, 32 or 64 tiles), then Render.
  Click a tile to see its authored atom stack and overrides.
- The image is the static preview (authored source plus compiled type defaults), not a
  client screenshot. The report lists everything not drawn exactly.
- Nothing is ever written: the preview has no edit or save path.
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
the .vsix, and also publishes to the Visual Studio Marketplace (secret `VSCE_PAT`) and Open VSX
(secret `OVSX_PAT`) when those repository secrets are set.

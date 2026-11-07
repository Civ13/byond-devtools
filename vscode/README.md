# BYOND Map Preview (VS Code)

A read-only custom editor for BYOND `.dmm` maps, built on byond-devtools.

- Open a map, then run **BYOND: Open BYOND Map Preview** (or right-click the file, or
  "Reopen Editor With..."). The text editor stays the default for `.dmm` files.
- Pick a z level, the bottom-left tile and a view size (16, 32 or 64 tiles), then Render.
  Click a tile to see its authored atom stack and overrides.
- The image is the static preview (authored source plus compiled type defaults), not a
  client screenshot. The report lists everything not drawn exactly.
- Nothing is ever written: the preview has no edit or save path.

Settings:

- `byondDevtools.byondBin`: your BYOND `bin` folder. The project's type tree is read with
  `DreamMaker -o` from a temporary folder, so nothing is written to your checkout.
- `byondDevtools.typeTree`: a saved type tree instead (`DreamMaker -o civ13.dme > tree.xml`).
- `byondDevtools.dme`: the project `.dme`, if the folder root has more than one.

Development: `npm ci`, then `npm test` runs the integration suite in a downloaded VS Code
(`VSCODE_VERSION=insiders npm test` for Insiders; Linux needs `xvfb-run -a`).
`npm run package` bundles the core and writes `byond-map-preview.vsix`; install it with
"Extensions: Install from VSIX...". Publishing to the Marketplace is a maintainer decision.

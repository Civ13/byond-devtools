byond-devtools is a dependency-free toolkit for BYOND maps.

## What's in it
- MCP server (`node src/mcp.js`) for agents: map inspection, renders (filters, boxes, animated PNGs), icon renders, icon diffs against a git revision (`icon_diff`), image comparison, live view dumps (`dump_render`), diffs, prefabs, contracts and safe edits, plus resources and prompts.
- CLI (`node src/cli.js`, Node 22+): `summary`, `cell`, `find`, `types`, `lint`, `icon`, `render` (static PNG of a map region), `ingame` (boots the game headless in a temp copy and renders the map after runtime icon changes and lighting) and `edit` (safe copy-on-write map edits, dry run by default) and `icon-diff` (state-by-state sprite review).
- **BYOND Map Editor** for VS Code (`byond-map-preview-VERSION.vsix`, attached): a custom editor for `.dmm` files with a rendered view (kind toggles, type highlighting, animated states and compare with a git revision), cell inspector and report, plus place, erase, stamp and move tools, var editing, undo/redo and verified saves; and **Compare icon with git revision** for `.dmi` files.

## Installing the VS Code editor
1. Download `byond-map-preview-VERSION.vsix` below.
2. In VS Code: Extensions, then the **...** menu, then **Install from VSIX...**, and pick the file.
3. Set `byondDevtools.byondBin` to your BYOND bin folder (for example `C:\Program Files (x86)\BYOND\bin`).
4. Open a `.dmm` file and run **BYOND: Open BYOND Map Editor**.

## Verification
CI runs on Linux and Windows. Its checks include native BYOND 516.1688 map-load agreement, all 279 Civ13 maps, and the VS Code integration suite on Stable and Insiders. See `docs/verification.md` for what each layer was checked against.

License: AGPL-3.0.

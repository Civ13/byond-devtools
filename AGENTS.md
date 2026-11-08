# BYOND Devtools agent guide

- Read README.md and docs/architecture.md before editing.
- Run `npm test` and `npm run check` before reporting completion.
- Keep the parser core independent of filesystem, network, execution and UI.
- Never execute DM expressions from maps. Keep unsupported values opaque or reject
  them with a source diagnostic; never silently drop map content.
- Preserve original text, ordered stacks, duplicate objects and variable overrides.
- Map writes go only through `src/edit.js` (pure) and `src/edit-project.js` (atomic apply);
  never write a map any other way. The VS Code editor saves through `editMapFile` too. No live-server operations or save migration. The only game boots are `src/ingame.js` and `playtest` in `src/devrun-project.js`
  (temp folder, -safe, 127.0.0.1, no saves), and only when the user asked for an in-game render or a playtest. Native BYOND runs are limited to `src/native.js` stub projects
  (generated types, `-safe`, temp directory); they never run game code. `DreamMaker -o`
  for the type tree runs from a temp probe so nothing is written into the project.
- The other file writes are `render --out`, `diff --out`, `prefab-* --out` (JSON, never overwritten) and `edit --inverse-out` (one PNG, no overwrite without `--force`).
  Prefabs place through an edit patch, never by writing the map.
  The renderer core (`src/render.js`) stays pure; file access lives in `src/render-project.js`.
- The MCP server (`src/mcp.js`) is read-only unless started with `--allow-write`; its only
  map write path is `map_edit` through `src/edit-project.js`. PNGs asked for with `file: true`
  go to the OS temp folder (`byond-devtools-mcp`), never the project. `ingame_render` boots the
  game through `src/ingame.js` only when the server was started with `--allow-game`.
- Do not vendor Civ13 maps/assets or third-party source without license review.
- Report passed, failed and unrun checks separately. Parser success is not native
  compile, gameplay validation, or a finished editor.

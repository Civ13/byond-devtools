# BYOND Devtools agent guide

- Read README.md and docs/architecture.md before editing.
- Run `npm test` and `npm run check` before reporting completion.
- Keep the parser core independent of filesystem, network, execution and UI.
- Never execute DM expressions from maps. Keep unsupported values opaque or reject
  them with a source diagnostic; never silently drop map content.
- Preserve original text, ordered stacks, duplicate objects and variable overrides.
- No map writes, game launches, live-server operations or save migration in this
  read-only milestone. Native BYOND runs are limited to `src/native.js` stub projects
  (generated types, `-safe`, temp directory); they never run game code.
- Do not vendor Civ13 maps/assets or third-party source without license review.
- Report passed, failed and unrun checks separately. Parser success is not native
  compile, gameplay validation, or a finished editor.

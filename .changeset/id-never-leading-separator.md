---
"sideshow": patch
---

Fixed a latent bug where post, surface, and session ids could start with `-`
or `_` (URL-safe base64 maps `+`→`-`, `/`→`_`, so ~1/64 of ids began with a
separator). Any id starting with `-` broke CLI commands that take an id as a
positional — `node:util` `parseArgs` treated it as an unknown option
(`Unknown option '-6'` for an id like `-6K4AJsKD4M`), affecting `sideshow
update`, `show`, and `surface add/remove/edit/move`. Two fixes:

- `newId` now swaps a leading separator for an alphanumeric, so new ids are
  always CLI-safe.
- The CLI's `parse()` wrapper swaps id-shaped `-`/`_`-prefixed tokens for a
  sentinel before `parseArgs` sees them, then restores them in the result
  (positionals, tokens, option values). This rescues already-stored ids that
  start with a separator.

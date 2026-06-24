---
"sideshow": minor
---

The local Node server now stores data in SQLite (via the built-in `node:sqlite`)
by default — the same `SqlStore` the Cloudflare Durable Object deploy runs, so
local development mirrors production over one storage code path instead of a
separate JSON file. On first SQLite boot an existing `sideshow.json` board is
migrated in once automatically (sessions, surfaces, version history, comment
ordering, and assets preserved); the JSON file is left untouched as a backup,
and the import never runs again or overwrites a non-empty database.

This also fixes the JSON store's scaling cliff — it rewrote the entire file
(assets base64-inlined) on every write — since assets are now per-row BLOBs.

Both stores now strip embedded NUL bytes from stored text (titles, comments,
trace labels, settings) so they behave identically — SQLite would otherwise
truncate a value at the first NUL while the JSON file preserved it.

Configuration: `SIDESHOW_STORE=json` keeps the legacy single-file JSON store;
`SIDESHOW_DB` sets the SQLite file path (default `data/sideshow.db`);
`SIDESHOW_DATA` still names the JSON file and doubles as the migration source.
The `sideshow/server` package now also exports `SqlStore` and
`createSqliteStorage` alongside `JsonFileStore`.

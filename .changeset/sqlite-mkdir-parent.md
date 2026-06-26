---
"sideshow": patch
---

Fix first-run crash when the SQLite db path's parent directory does not exist. `node:sqlite` does not create missing parent directories, so the default `<package-root>/data/sideshow.db` path (no `data/` shipped in the package) failed with `ERR_SQLITE_ERROR: unable to open database file` on a fresh `npx sideshow serve`. `createSqliteStorage` now `mkdirSync(dirname(path), { recursive: true })` before opening, guarded by the existing `:memory:` check so the in-memory contract suite is untouched. A user-supplied `SIDESHOW_DB` pointing into a not-yet-created directory now works too.

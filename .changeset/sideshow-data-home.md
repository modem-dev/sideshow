---
"sideshow": patch
---

Move the default data directory from the package-relative `<package-root>/data/` to a user-owned `~/.sideshow/`. The package-relative default was read-only under `sudo npm install -g` (crashing with `EACCES` even after the #157 mkdir guard) and was wiped on every `npm install -g` upgrade — silent data loss. `~/.sideshow/` is always writable and survives reinstalls. A one-time migration copies any existing `sideshow.{db,db-wal,db-shm,json}` from the old location to the new one on first boot (only when using default paths; `SIDESHOW_DATA`/`SIDESHOW_DB` overrides are unchanged and skip the migration).

---
"sideshow": patch
---

Fix a lost-update race in `SqlStore.updateSurface`. Two concurrent `PUT /api/surfaces/:id` calls could both read the same version, push a duplicate history entry, and write the same version number — silently losing one caller's parts. The fix uses compare-and-set (`WHERE id=? AND version=?`) with `SELECT changes()` to detect whether the update landed, retrying with the current version if it lost the race.

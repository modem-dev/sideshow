---
"sideshow": minor
---

Return per-surface ids, kinds, and indexes in write responses without echoing surface payload bodies, and remove the redundant top-level `kinds` array. Read kinds from `surfaces.map((surface) => surface.kind)` instead.

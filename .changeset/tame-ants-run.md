---
"sideshow": patch
---

Reduce the optimistic-asset wait from 3 seconds to 1 second. When a surface references an asset that was evicted (or never uploaded), `GET /a/:id` no longer spins for 3 seconds before 404ing. The upload is either in-flight (sub-second) or never coming, so 1 second is plenty for the optimistic window.

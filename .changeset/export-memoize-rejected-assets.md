---
"sideshow": patch
---

Session export now fetches a missing or non-image asset at most once per export. A session referencing one bad asset from many image surfaces previously re-read it per reference — a full byte clone or blob `SELECT` each time — which an unauthenticated reader could retrigger on a `publicRead` workspace.

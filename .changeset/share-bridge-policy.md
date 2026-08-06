---
"sideshow": patch
---

The session export and the live viewer now share one link/resize policy (`server/bridgePolicy.ts`) instead of each restating it, and the export reuses the render cache `/s/:id` already populated — so exporting a session you just viewed skips re-running syntax highlighting and diff rendering for every surface. A garbage bridge-reported height now floors to the minimum in the viewer instead of producing an invalid CSS length.

---
"sideshow": minor
---

Embeddable engine: add a `ss:session-actions` host-overridable slot (`SLOTS.sessionActions`) in the session header, beside the stream/timeline toggle. It is empty by default — self-hosted renders nothing there — so an embedder (e.g. sideshow cloud) can project session-scoped controls such as a "Share" button into the engine's own chrome without forking the viewer.

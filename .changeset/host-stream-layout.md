---
"sideshow": minor
---

Embeddable engine: expose `layout` and `readonly` on the `SideshowHost` contract. A host can now request the stream-only layout (`layout: "stream"` — no sidebar/session list, just the current session's stream) and hide write affordances (`readonly: true`) without relying on the self-hosted `window.__SIDESHOW_*` globals. Self-hosted public-read "session" links keep mapping to the stream layout, so that flow is unchanged.

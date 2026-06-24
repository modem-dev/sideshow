---
"sideshow": patch
---

Sandbox the `/s/:id` surface document with a CSP response header, so agent
script can never run in the board origin even on a top-level load. The viewer
embeds surfaces in a `sandbox="allow-scripts"` iframe (opaque origin), but the
document is served from the board's own origin — so opening `/s/:id` directly (a
user choosing "open frame in new tab", an agent-shared link) ran the agent's
script _in the board origin_, where it could reach same-origin storage or
`window.open()` the real viewer. A `sandbox` directive can only be set as a
response header (not the page's meta-tag CSP), and now forces the same
opaque-origin sandbox however the document is loaded: `allow-scripts` so the
bridge still runs, never `allow-same-origin`. Mirrors the iframe's own flags.

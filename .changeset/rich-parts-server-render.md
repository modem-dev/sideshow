---
"sideshow": patch
---

Fix rich parts (markdown/code/diff/terminal) that intermittently rendered blank
or clipped on reload under a Chrome 149 field trial, by rendering them
server-side and serving each from `/s/:id?part=N` by real URL — the same
opaque-origin, real-navigation load path html parts already use, which the field
trial doesn't break (it defers layout only for in-memory `srcdoc`/`blob:`
documents). Rich documents render with shiki, @pierre/diffs, markdown-it, and
ansi_up on the server (no DOM/WASM, so they run on the Worker too) under a tight
`sandbox` CSP response header with no `connect-src` and no CDN script source.
Mermaid, which needs a DOM, instead emits a self-rendering document that loads
mermaid from the CDN inside the sandbox. Versioned, themed `/s/:id` responses
are immutable, so they now carry a long-lived `Cache-Control` and an in-memory
render cache. Removes the viewer→server `POST /api/frames` → `/f/:id` round-trip
and transient frame store the previous workaround added, and drops mermaid and
shiki from the viewer bundle.

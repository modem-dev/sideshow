---
"sideshow": patch
---

Fix surface iframes rendering in the wrong color scheme when it diverges from
the chrome (e.g. dark chrome with a white, light-inked html part). Light/dark
was resolved independently in every layer purely from the OS
`prefers-color-scheme`, but a surface part is a separate iframe document whose
scheme resolution can diverge from its embedder across the frame boundary. The
viewer now resolves the scheme once and pins each sandboxed frame to it — html
parts via a `mode` query param on `/s/:id` (with a forced `color-scheme`), and
markdown/code/comment frames via `renderSandboxedPart` — so a frame always
matches the chrome instead of re-deriving the scheme on its own. The theme
tokens, the kit's teal/coral SVG accents, and shiki's dark flip are all pinned
together. With no mode passed the OS media query is kept, so self-hosted parity
is preserved.

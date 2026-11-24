---
"sideshow": minor
---

Add fullscreen for surfaces. Every sandboxed surface (html, markdown, code, diff, terminal, mermaid) now has an expand button that opens it over the viewer, with a control for real browser fullscreen — in place, so a deck keeps its slide and a widget keeps its state. An html surface's own `requestFullscreen()` / `exitFullscreen()` now work too: the sandboxed frame routes the standard Fullscreen API through the viewer (user gesture required), and the fullscreen element is marked `[data-sideshow-fullscreen]`. The `slides` kit gains a fullscreen button.

---
"sideshow": minor
---

Add an embeddable viewer engine. `mountViewer(el, host)` (the new
`sideshow/viewer-embed` export) renders the viewer into a shadow root with its
own runtime, reading its base path, route, and theme from an injected host
instead of `window`/`location` — so a host application can own the page shell
and URL while embedding the viewer. The self-hosted page is unchanged: it now
uses a trivial default History-API host and behaves identically.

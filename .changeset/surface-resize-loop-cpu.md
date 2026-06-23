---
"sideshow": patch
---

Fix an auto-resize feedback loop that could pin a CPU core. A sandboxed surface reports its content height to the host, which sizes the iframe to match; when the content's height inverts with the frame height (a scrollbar that toggles at a threshold, a 100vh/percentage layout), sizing the frame changes the content height back, so reports alternate A, B, A, B… once per frame. The old `h !== lastH` guard couldn't catch a 2-cycle, and on a heavy syntax-highlighted surface each relayout was expensive enough to sit at 100% CPU until the surface unmounted. The height reporter now remembers the previous height and drops a rapid return to it (< 250ms), breaking the loop while still honoring genuine changes (a `<details>` toggle, a textarea drag) that recur on a human timescale.

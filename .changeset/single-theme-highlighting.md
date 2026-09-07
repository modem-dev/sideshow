---
"sideshow": patch
---

Highlight code against one theme instead of two when the color scheme is already
known. shiki tokenizes once per theme, so asking for a light/dark pair costs
exactly twice as much — and the viewer always tells the server which scheme it
resolved, so half that work was being discarded with CSS. Rendering a
1400-line code surface drops from 1.14s to 543ms and its document from 751KB to
529KB; markdown with fenced code improves by roughly the same proportion. An
unpinned direct load of `/s/:id` still gets both themes and follows the OS.

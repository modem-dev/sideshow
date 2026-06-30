---
"sideshow": patch
---

Fix markdown/code/diff/mermaid surfaces rendering on a white canvas (washed-out
text) on a dark board. These rich-part frames are sandboxed opaque-origin
iframes, which default to `color-scheme: normal` (light), so in dark mode the UA
painted a white backdrop behind the transparent body. They now pin `color-scheme`
to the resolved scheme — like html surfaces already do — so the frame's canvas
tracks the card in both light and dark.

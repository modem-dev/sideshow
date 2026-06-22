---
"sideshow": patch
---

fix(viewer): honor `lineStart` in code-part gutter numbers. The code part's range label already reflected `lineStart`, but the gutter still counted from 1 — shiki emits `<pre class="shiki …" style="…">`, which the counter-reset injection didn't match. The starting line number now applies, so excerpts render at their original line numbers.

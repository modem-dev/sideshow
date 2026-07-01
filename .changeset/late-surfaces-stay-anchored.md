---
"sideshow": patch
---

Keep the scroll position anchored when surfaces resize late. On slow networks a
surface iframe can report its real height seconds after the page settles; the
viewer now compensates scrollTop when a surface above the viewport resizes (in
every browser and embed, not just where native scroll anchoring happens to
apply), and a deep-linked post stays pinned until you scroll — never held by a
timer, never fighting your input.

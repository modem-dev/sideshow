---
"sideshow": patch
---

Slides kit now grid-stacks its deck so it cross-fades in normal flow. Previously
it swapped slides with `display:none`, which can't fade — so decks were hand-rolled
with `position:absolute` slides over a `min-height` stage, an out-of-flow layout the
surface-page height bridge can't measure (the overlay grows `scrollHeight` but not
the box its ResizeObserver watches), leaving the frame clipped/frozen. The kit now
stacks slides in one grid cell (in flow, sized to the tallest slide) and fades with
opacity/visibility, so the frame follows it. DESIGN_GUIDE documents the out-of-flow
trap and the grid-stack recipe alongside the existing `position: fixed` ban.

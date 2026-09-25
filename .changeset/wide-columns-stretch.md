---
"sideshow": minor
---

Add an opt-in wide layout: a toggle beside Stream/Timeline lets the feed column grow past 860px (up to 1600px) on wide windows so diffs, code, diagrams and html use the space, while markdown prose stays capped at its normal-column width (code blocks and tables inside markdown go full width), and long lines in markdown code blocks, code, terminal and diff surfaces soft-wrap instead of scrolling sideways. The choice is saved per workspace (`PUT /api/width` with `{"id":"wide"}`), and normal stays the default.

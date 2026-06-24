---
"sideshow": patch
---

Mermaid diagrams now fully re-theme on a light/dark flip. The renderer drove mermaid's `base` theme from the design tokens but left mermaid to derive the rest, so colors it computes itself stayed stuck in light mode — most visibly arrowheads (derived from a hardcoded light canvas) kept their dark fill while the edges they cap flipped. The renderer now passes `darkMode` and `background` and pins the previously-derived arrow/text colors to the viewer's tokens, so every element tracks the active scheme.

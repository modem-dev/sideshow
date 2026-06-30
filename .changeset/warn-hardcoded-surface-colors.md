---
"sideshow": patch
---

Warn at publish time when an html surface hardcodes scheme colors. A
`background`/`color` set to a literal (hex/rgb/hsl/white/black) instead of a
`--color-*` theme token renders washed-out on a board in the opposite scheme;
the publish/revise API now returns a non-blocking `warnings` array pointing the
agent at the theme tokens. Token-driven surfaces (and other surface kinds) are
unaffected.

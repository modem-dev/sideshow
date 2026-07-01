---
"sideshow": minor
---

Embed host contract: `onThemeChange` now receives a second `meta` argument —
`{ theme, mode }` — naming the resolved theme id and light/dark scheme behind the
tokens it already reports. Hosts that re-render surfaces out-of-band (e.g.
server-side preview frames they can't theme from the token values alone) can pass
those identifiers to `/s/:id?theme=&mode=` to reproduce the exact look; hosts that
only paint from the token values ignore it. Additive — the tokens argument is
unchanged and the default self-hosted host is unaffected.

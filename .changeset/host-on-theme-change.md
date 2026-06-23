---
"sideshow": minor
---

Embeddable engine: add `onThemeChange?(tokens)` to the Host contract. The engine now PUSHES its fully-resolved palette to the host on initial mount, on every live theme switch, and on an OS light/dark flip — symmetric with `router.navigate`. An embedder (e.g. sideshow cloud) mirrors those tokens onto its own chrome instead of scraping computed styles across the shadow boundary. Optional: the trivial self-hosted host omits it, so self-hosted behaviour is unchanged.

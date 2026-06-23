---
"sideshow": minor
---

Embeddable engine: publish the theme-token contract as data via a new lightweight `sideshow/theme-tokens` entry (also re-exported from `sideshow/viewer-embed`). It exports `THEME_TOKEN_NAMES` (the coarse subset of palette vars a host mirrors), the `ThemeTokens` type, and `THEME_DEFAULTS` (the default theme's built-in light/dark values, derived from the theme registry — never hand-copied). A host (e.g. sideshow cloud) can now consume the token names and no-flash fallback colors as typed data instead of copying hex by hand, so the two design systems can't silently drift. The `/theme-tokens` entry is engine-free and Node-safe, so build scripts can read it without pulling in the viewer runtime.

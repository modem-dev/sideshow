---
"sideshow": patch
---

Drop the dead `/u/`-prefix URL fallback from the default viewer host. The
embeddable engine's `createDefaultHost()` now derives its base path solely from
`window.__SIDESHOW_BASE_PATH__` (empty at root) instead of also sniffing a
`/u/:account` prefix out of `location.pathname`. That fallback was specific to an
old hosted-wrapper URL shape; self-hosted sideshow already runs at the root or
sets the global explicitly, so behavior is unchanged for every supported host.

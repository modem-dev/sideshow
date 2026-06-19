---
"sideshow": minor
---

Add opt-in **kits** for html parts. An html part can list kit ids in `kits` to
pull in a richer, theme-aware vocabulary; a plain html part is unchanged, so
default html stays freeform. Two kits ship: `issues` (cards, a nesting `.tree`
rail, status badges/dots, mono chips, rollup bars — composes an issue/PR/CI tree
or status board from generic primitives) and `slides` (a stepped `.deck` with
injected prev/next controls and a counter). Available on every tier:
`sideshow publish … --kit issues` (CLI), a `kits` field on `publish_surface` /
`publish_snippet` (MCP), and on `POST /api/snippets` / parts (HTTP). Discover
them with `sideshow kits` or `GET /api/kits`. Unknown ids are a clean 400 over
REST and filtered over MCP.

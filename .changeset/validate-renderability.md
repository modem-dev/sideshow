---
"sideshow": patch
---

Submit-time validation now rejects diffs and mermaid diagrams that won't
render, not just ones with the wrong shape. A `diff` part whose `patch`
parses to zero files (e.g. a hunk without `---`/`+++` headers) returns a
`400` from `POST /api/surfaces` and `PUT /api/surfaces/:id` with the parse
error. A `mermaid` part whose source fails to parse also returns a `400`;
the parser (`@mermaid-js/parser`, the official mermaid-js extraction) covers
the 15 Langium-migrated diagram types (pie, gitGraph, architecture, radar,
treemap, wardley, …) — types still on Jison (flowchart, sequence, class,
state, er, gantt) skip validation and fall back to the viewer's existing
graceful render-failure UI. MCP tool calls (loose mode) drop the invalid
part instead of publishing a broken card.

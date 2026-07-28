---
"sideshow": patch
---

Stop shipping surface bodies the viewer never reads in the session hydrate
response. Opening a session fetches `GET /api/sessions/:id/posts?hydrate=1`,
which served every post through `postDetailView` — the full current surfaces
plus every prior version's surfaces. But a sandboxed surface (`html`, `diff`,
`markdown`, `terminal`, `mermaid`, `code`) renders as an opaque-origin iframe
pointed at `/s/:id?part=N`, which fetches its own body; the viewer only ever
reads `{ id, kind, index }` to build that URL. So the hydrate response carried a
second, unread copy of every surface in the session, and it blocks the stream
from rendering.

`?hydrate=1` now drops just the content field of sandboxed surfaces, and reduces
history surfaces to refs (history is there to size the version dropdown —
choosing an older version re-points each iframe at `?ver=N`, so past bodies are
never rendered from this payload either). Native kinds — `image`, `trace`,
`json` — do render from inline data and are untouched. Across the six largest
sessions in a real store this cut the response 95% raw / 91% gzipped.

`GET /api/posts/:id` and the MCP `read_post` tool still return full detail; only
the session-list hydrate view changed.

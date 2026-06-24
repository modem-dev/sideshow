---
"sideshow": patch
---

Cap every request body so an oversize JSON or MCP payload can't OOM the server.
The previous fix bounded `/api/assets`, but every other write endpoint
(`/api/surfaces`, `/api/comments`, `/api/sessions`, the trace ingest, `/api/theme`)
and `/mcp` still read their body with an unbounded `c.req.json()` — so the same
unauthenticated out-of-memory vector was reachable by POSTing a giant JSON body
instead (the local default has no auth token). A global `bodyLimit` now rejects
any request body over a generous ceiling with a 413, short-circuiting on an
oversize `Content-Length` and otherwise aborting the stream at the cap so a
chunked body can't slip past. It runs after auth (unauthenticated requests on a
token board are refused before their body is read) and exempts `/api/assets`,
which streams its own stricter cap.

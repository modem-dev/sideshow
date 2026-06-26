---
"sideshow": patch
---

Held SSE (`/api/events`) and long-poll (`/api/comments?wait=N`) connections
are now bounded per workspace. Both are GETs that pin a socket open and, on a
`publicRead` board, are reachable unauthenticated — without a ceiling a flood
could exhaust connections (cleanup was already correct, there was just no
limit). Once over `maxHoldConnections` (default 32, configurable via
`AppOptions`), new held connections return `503`; an instant `?wait=0` read
still succeeds since it doesn't hold a slot. Slots release exactly once on
stream/request abort or normal return. The default is sized for the real
concurrency of a single-user workspace — a few viewer tabs (one SSE each) plus
active agent long-polls, including a multi-agent session with several agents
connected at once — since one workspace is one user; a real flood is orders of
magnitude bigger, so the cap rejects it regardless of the exact default.

Also indexes the referenced-asset set used by `/a/:id`'s optimistic-read wait
and asset eviction: it was re-parsing every post's `surfaces` + `history` JSON
on each call (a full-table scan on every `/a/:id` miss), and is now built
lazily and maintained incrementally on post create/update and invalidated on
remove. History is append-only, so an asset id once referenced stays
referenced until its whole post is deleted — the cache stays correct without
re-scanning.

---
"sideshow": patch
---

Cap the asset-upload body while streaming so a chunked request can't OOM the
server. `POST /api/assets` rejected oversize uploads by their `Content-Length`
header, then read the rest with `arrayBuffer()` — but a chunked upload sends no
`Content-Length`, so the header check was skipped and the entire body was
buffered into memory before any size check. On a board reachable beyond
localhost (and the local default has no auth token), that's an unauthenticated
out-of-memory vector. The body is now read through a capped reader that stops at
the same limit, so an over-cap stream is refused with a 413 without being
buffered first. The post-decode cap in `uploadAsset` is unchanged.

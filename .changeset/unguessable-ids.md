---
"sideshow": patch
---

Harden share-link secrecy: session and surface ids are now 11 url-safe base64
characters — 8 random bytes, ~64 bits, YouTube-video-id sized — instead of a
UUID's first 32-bit segment. In `publicRead` mode these ids double as bearer
capabilities (`/s/:id` and `/api/{sessions,surfaces}/:id` are reachable without
the board token), so a 32-bit id (~4e9) was enumerable; 64 bits (~1.8e19) is
far past sweepable. Existing ids keep working — nothing validates id shape — so
only newly minted ones change. (Asset ids are a separate content hash and were
already unguessable.)

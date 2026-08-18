---
"sideshow": patch
---

Make recent-post ordering deterministic when multiple writes share the same millisecond timestamp, preventing different SQLite versions from selecting different posts at the result limit.

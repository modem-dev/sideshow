---
"sideshow": patch
---

`sideshow update` now preserves the surface kind instead of always treating
content as HTML. A markdown post updated with `sideshow update <id> file.md`
stays markdown; a code post stays code with its language preserved; diffs keep
their layout, terminals keep their cols — every kind-specific field is carried
forward. The same fix applies to all text-content surface kinds (html,
markdown, code, diff, terminal, mermaid, json).

Implemented as a new `PATCH /api/posts/:id` endpoint that accepts raw
`content` (plus optional `title` and `kits`) and slots it into the existing
surface's kind, rather than requiring the caller to construct the full typed
surface object. Multi-surface posts return a 400 for now — surface-level
targeting is a future addition. The existing `PUT` full-replacement API is
unchanged.

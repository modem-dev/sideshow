---
"sideshow": patch
---

Tighten input validation at the edges:

- Malformed base64 in an asset upload (REST `/api/assets` and the `upload_asset`
  MCP tool) now returns a clean 400 instead of surfacing a raw decode error as a 500.
- Comment text and surface/session titles are capped (8 KB / 500 chars) before
  they ride the feedback channel back to the agent, so one oversize value can't
  bloat the agent's context on every poll.
- The CLI's `--after` flag (`wait`, `watch`) now fails fast on a non-numeric
  value instead of silently ignoring it.

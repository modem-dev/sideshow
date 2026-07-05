---
"sideshow": patch
---

Emit canonical `/p/<id>` post links everywhere a link is produced, finishing
the post/surface vocabulary migration. The CLI (`sideshow publish` / `update`
output), the viewer's copy-link and open-as-image actions, the `<link
rel="canonical">` / OpenGraph preview tags, the viewer's History API URL shapes
(`/p/:id` and `/session/:id/p/:postId`), and every MCP tool response —
including the deprecated `publish_surface` / `publish_snippet` aliases — now
return `/p/` URLs.

Nothing inbound changes: `/s/:id`, `/session/:id/s/:postId`, and `/s/:id.png`
remain accepted as legacy aliases (the screenshot Worker now matches both
`/p/:id.png` and `/s/:id.png`), and old `/s/` links keep resolving to the same
post page.

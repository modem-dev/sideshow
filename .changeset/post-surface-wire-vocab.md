---
"sideshow": minor
---

Bring the new **post / surface** vocabulary to the HTTP and MCP wire layers,
additively. The canonical hierarchy is now **workspace ▸ session ▸ post ▸
surface** (a post is an ordered list of surfaces); the older spellings keep
working as deprecated aliases — nothing is removed.

New HTTP routes mirror the existing surface routes, sharing the same handlers:
`GET/POST/PUT/DELETE /api/posts(/:id)`, `GET /p/:id` (with `?surface=N`),
`GET /session/:id/p/:postId`, and `GET /api/sessions/:id/posts`. The publish
and revise handlers now accept a `surfaces` body (falling back to the legacy
`parts`), so both `/api/posts` and `/api/surfaces` take either field; `/p/:id`
and `/s/:id` accept `?surface=N` as well as `?part=N`.

New MCP tools `publish_post`, `update_post`, and `list_posts` are advertised on
both transports, advertising a `surfaces` argument and emitting `/p/<id>` view
URLs. The legacy `publish_surface` / `update_surface` / `list_surfaces` tools
remain (now described as deprecated aliases) and still accept `parts`.
`reply_to_user` additionally accepts a `postId` argument. Tool prose and schemas
are rewritten in the new vocabulary (surface→post, part→surface,
board→workspace).

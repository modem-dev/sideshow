---
"sideshow": patch
---

Fix blank page when opening a post permalink (`/p/:id`) on a
`publicRead="session"` workspace without authentication. The SSE connection
fired before the viewer discovered the post's session ID, hitting `/api/events`
without the required `?session=` param and getting a 401. The connection is now
deferred until after the initial post fetch resolves.

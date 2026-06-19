---
"sideshow": minor
---

Deep-linkable URLs: the viewer URL now reflects the current session and surface (`/session/:id`, `/session/:id/s/:surfaceId`). Clicking sessions pushes browser history, scrolling updates the surface in the URL via `replaceState`, and `/` redirects to the last-viewed session. Back/forward navigation works across sessions.

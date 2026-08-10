---
"sideshow": patch
---

Coalesce the session-list refreshes triggered by a burst of live post events. Each post still streams into the open session independently, while sidebar metadata waits for a short quiet window and shares one request instead of fetching the full session list once per post.

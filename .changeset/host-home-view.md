---
"sideshow": minor
---

Add a `homeView` flag to the embed host contract. When a host owns its own session-less landing (e.g. a "home" feed), the engine no longer auto-selects a session on boot — it honors a deep-linked route session but otherwise stays session-less so nothing is highlighted behind the host's landing, and it clears the selection when the route later becomes session-less. Self-hosted leaves the flag unset and is unchanged (auto-selects the latest session on boot).

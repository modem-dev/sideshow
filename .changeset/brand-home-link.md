---
"sideshow": minor
---

Viewer: the sidebar wordmark is now a home link. Clicking "sideshow" (in the aside, or the mobile topbar) clears the current session and returns to the session-less base route — a guaranteed way back to the board from anywhere. It's a real `<button>`, so it's keyboard- and screen-reader-reachable. The new `goHome()` always asks the host to navigate (it never short-circuits on the engine's own selection), so an embedding host that layers its own view over the board — e.g. sideshow cloud's full-page Settings, which has no session rows to click out of on an empty board — gets a reliable exit through the same click; the host dedupes a no-op move. Self-hosted behaviour is otherwise unchanged.

---
"sideshow": minor
---

Embeddable engine: add `onReady?()` to the `SideshowHost` contract and stop flashing the empty-board onboarding before sessions load. On mount the board has no sessions yet, so it rendered `#onboard` (the "setup" pane) until `/api/sessions` resolved, then swapped to a session — a visible flash. The onboarding pane is now gated behind a first-load signal so neither pane is decided before that fetch returns, and the engine calls `host.onReady()` once it resolves and the board is decided. An embedder (e.g. sideshow cloud) holds its loading overlay until then so its users never see the pre-load flash; it fires even if the fetch failed (the board falls back to onboarding), so an overlay can't get stuck. Optional: the trivial self-hosted host omits it — self-hosted simply no longer flashes onboard.

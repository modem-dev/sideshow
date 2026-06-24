---
"sideshow": minor
---

Embeddable engine: add a `ss:main` host-overridable slot (`SLOTS.main`) wrapping the whole main content pane (onboarding + session stream). Its fallback is the engine's normal board, so a plain embed and self-hosted sideshow are unchanged. Unlike the always-on footer/empty/session-action overrides, this one is meant to be projected conditionally: an embedder (e.g. sideshow cloud) projects a `slot="ss:main"` child only while its own full-pane view is active — taking over the main area while the sidebar (session list, account footer) stays — and the engine falls back to the board when the child is gone.

---
"sideshow": minor
---

Add a pickable board theme. A theme selector in the sidebar switches the whole board at once — viewer chrome, markdown code and diff syntax (shiki), and the html surface-part tokens — between presets (GitHub, Gruvbox, One). Each theme is authored as one palette per light/dark in a shared registry (`server/themes.ts`); the chrome variables and the agent-facing `--color-*` tokens are derived from it, so the two palettes can't drift. The choice persists per board (new `getSetting`/`setSetting` store methods, backed by JsonFileStore and SqlStore) and propagates to other open tabs over a `theme-changed` event. The agent-facing token contract is unchanged — the same variable names resolve to the selected theme's values, so existing html snippets re-theme for free. Default is GitHub.

---
"sideshow": minor
---

Add an `issue-tree` surface part. Agents hand over a `root` issue whose `children` are more issues of the same shape, and the viewer renders it natively as a tight rail/elbow tree with a progress rollup computed (`done ÷ total` over descendants) — never stored, so editing a leaf moves the bar. Each node is `{ ref, title, state, source?, note?, url?, children? }`; `state` is one of `open | in-progress | blocked | done | closed`, and `source` (github / linear / jira / gitlab / sentry / …) drives a source chip — so a tree can nest across providers (a Linear epic owning a GitHub sub-issue and a Sentry leaf). Available on all three tiers: an `issue-tree` part over MCP and `POST /api/surfaces`, plus the CLI (`sideshow issue-tree`, and `--issue-tree` on `sideshow publish`). Rendered from data, not sandboxed markup; the viewer themes it (light and dark) from chrome tokens, including a new `--ok` status green.

---
"sideshow": minor
---

Comments now always attach to a surface. The empty "Session thread" card is
gone from the viewer, and surface-less comments can no longer be created over
HTTP or the CLI (`sideshow comment` now requires `--surface`). Talking to the
agent without pointing at a surface is what the agent's own prompt is for; the
agent-facing feedback stream (`?session=…&author=user`) is unchanged.

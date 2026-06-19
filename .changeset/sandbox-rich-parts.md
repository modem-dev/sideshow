---
"sideshow": minor
---

Harden surface isolation: markdown, mermaid, diff, and terminal parts now render
inside the same opaque-origin sandboxed iframe that html parts use, instead of
via `innerHTML` in the trusted viewer. Each part is rendered to a string in the
viewer (string building is not a DOM sink) and parsed inside the sandbox under a
tight CSP with no `connect-src`, so a markdown-it / shiki / mermaid / DOMPurify /
@pierre-diffs / ansi_up sanitizer regression can no longer reach the board or
inject comments to the agent. Comment text is wrapped in the same sandbox too.
Image and trace parts already had no HTML sink. No visible change to how parts
or comments render.

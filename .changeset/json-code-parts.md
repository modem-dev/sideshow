---
"sideshow": minor
---

Add `json` and `code` part kinds for surfaces.

- **`json`** — a pre-parsed JSON value rendered natively by the trusted viewer
  as a collapsible tree. Objects and arrays expand/collapse on click; primitives
  show inline with type-colored values (strings, numbers, booleans, null). Reach
  for it for API responses, config files, test results — any structured data
  where a tree beats a fenced code block. Like image/trace it is data, not
  markup: the viewer renders it with escaped text nodes, so no sandbox is needed.

- **`code`** — source code highlighted with shiki (the same highlighter as
  markdown fenced code blocks), rendered in a sandboxed iframe with line
  numbers, an optional filename header, and a copy button. `language` is a
  shiki lang id; `title` is a filename shown in the header; `lineStart` shows
  original line numbers for excerpts ("lines 80-150 of x.ts"). CLI:
  `sideshow code app.ts --title "app.ts" --line-start 80`.

Also extracts the shared shiki highlighter into `viewer/src/highlight.ts` so
MarkdownPart and CodePart share one lazy-loaded highlighter.

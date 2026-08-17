---
"sideshow": minor
---

viewer: fold the card's export actions into one share menu, with copy-as-markdown

A card's footer carried three separate icons that all meant "take this
elsewhere" — copy link, open in a new tab, open as a PNG — and no room for a
fourth. They are now rows in a single **Share** menu, joined by **Copy as
markdown**: the whole post as portable markdown, with prose kept as prose,
code/diffs/terminal output/JSON/mermaid as fenced blocks, images as image links,
and an html surface degraded to a link back to it rather than a dump of its
markup.

The flattening is served, not derived in the browser, so every tier can have it:
`GET /api/posts/:id/markdown` returns the same text for `curl` and the CLI.

---
"sideshow": minor
---

Download a surface as the file it came from. Every surface on a card now has a
row in its share menu — "Download diagram.mmd", "Download change.patch",
"Download plan.md" — serving the raw source behind it rather than a rendering,
so a diagram comes back editable and a diff comes back appliable. The bytes are
also available to the CLI and curl tiers at
`GET /api/posts/:id/surfaces/:target/raw`, addressed by surface id or index.

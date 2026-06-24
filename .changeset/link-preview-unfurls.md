---
"sideshow": minor
---

Link unfurl / inline preview support. Bare `/s/:id` URLs now serve the viewer shell with Open Graph and Twitter Card metadata, so pasting a surface link into Slack, Twitter/X, Discord, or iMessage renders an inline preview card. The `og:image` points to `/s/:id.png?card=1`, which captures a fixed 1200×630 social-card screenshot. Metadata uses only the surface title and a static description — no tokens or session context are leaked.

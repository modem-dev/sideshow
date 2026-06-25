---
"sideshow": minor
---

Direct links to a surface open a full-page standalone view again. Visiting a bare `/s/:id` URL now shows just that one surface — its title and parts, no sidebar, session feed, or comment thread — with a small "made with sideshow" watermark beneath it, instead of resolving the link into its session's stream. The parts still render in the same sandboxed iframes the board uses (sized by the same resize bridge), and the link keeps its canonical `/s/:id` URL. Link-preview metadata from the bare route is unchanged.

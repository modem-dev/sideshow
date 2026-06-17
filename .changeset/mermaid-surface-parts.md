---
"sideshow": minor
---

Add a `mermaid` surface part. Agents hand over diagram source (flowchart, sequence, ERD, gantt, state, …) and the viewer renders it natively to an SVG — themed in the sideshow palette and font (light and dark), with flowchart nodes/edges that can opt into the accent color via `:::accent` / `accentLine`. Available on all three tiers: a `mermaid` part over MCP and `POST /api/surfaces`, plus the CLI (`sideshow mermaid`, and `--mermaid` on `sideshow publish`). Rendered as data, not sandboxed markup — mermaid runs with securityLevel `strict`, and an invalid diagram shows its source in an error fallback instead of breaking the card.

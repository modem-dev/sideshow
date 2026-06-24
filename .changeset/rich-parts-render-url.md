---
"sideshow": patch
---

Fix rich parts (markdown/mermaid/diff/terminal/code and comments) that
intermittently rendered blank or clipped on reload under a Chrome 149 field
trial. The viewer now stages each rich frame's rendered document at `/f/:id`
and loads it by real URL — like html parts at `/s/:id` — instead of an in-memory
`srcdoc` document, which is the layout path the field trial breaks. The response
carries the same `sandbox` CSP header `/s/:id` uses, so the frame stays
opaque-origin with no `allow-same-origin` and its tight CSP is unchanged — the
isolation boundary is identical, only the document's load path differs. Removes
the `srcdoc` reparse retry the previous workaround added.

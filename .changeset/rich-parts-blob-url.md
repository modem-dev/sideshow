---
"sideshow": patch
---

Fix rich parts (markdown/mermaid/diff/terminal/code and comments) that
intermittently rendered blank or clipped on reload under a Chrome 149 field
trial. The viewer now loads each rich frame from a `blob:` URL instead of
`srcdoc`, which sidesteps the opaque-origin _srcdoc_ layout path the field trial
breaks. The frame stays sandboxed `allow-scripts` with no `allow-same-origin`,
so its opaque origin and tight CSP are unchanged — the isolation boundary is
identical, only the document's load path differs. Removes the `srcdoc` reparse
retry the previous workaround added.

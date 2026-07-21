---
"sideshow": minor
---

Add session HTML export. `GET /api/sessions/:id/export` and the new `sideshow export` command render a whole session into one self-contained, shareable HTML file styled like the viewer's card column. Every surface that becomes HTML is embedded as a sandboxed `srcdoc` iframe using the exact `/s/:id` renderers, so the isolation rule holds inside the saved file; image surfaces are inlined as data URIs (allowlisted raster types only, capped at 32 MB of image bytes per export — further images degrade to a note), and sessions over 4 MB of surface text are rejected with a 413. Supports `?theme=`/`?mode=` pinning and `?download=1` for an attachment download.

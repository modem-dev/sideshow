---
"sideshow": patch
---

Fix rich surfaces that intermittently render blank or clipped under a Chrome field trial. Rich `srcdoc` frames now avoid the affected opaque-origin layout path, while a per-document CSP nonce limits script execution to the trusted resize and interaction bridge.

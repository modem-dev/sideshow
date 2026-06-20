---
"sideshow": patch
---

Fix invisible markdown/mermaid/diff/terminal surfaces caused by a Chrome field trial that breaks layout measurement in opaque-origin srcdoc iframes. The viewer now retries the srcdoc parse after 2 seconds if the iframe is still stuck at minimum height.

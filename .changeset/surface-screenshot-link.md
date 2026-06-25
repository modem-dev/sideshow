---
"sideshow": minor
---

Each surface footer gains an **open-as-image** action that opens the surface
rendered as a PNG (`/s/:id.png`). The image is captured by Cloudflare Browser
Rendering, so the action is live only on a Workers deployment; on a plain Node
server it is shown but disabled, with a tooltip pointing at the README. The
embeddable engine learns the capability through a new host field
(`SideshowHost.screenshots`); `createApp({ screenshots })` surfaces it to the
self-hosted viewer via `window.__SIDESHOW_SCREENSHOTS__`, and the Workers entry
sets it (the Node entry leaves it off).

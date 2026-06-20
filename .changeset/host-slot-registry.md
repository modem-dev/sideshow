---
"sideshow": minor
---

Add a host-extension seam so a wrapping deployment can render its own components inside the viewer chrome without forking it. The viewer now publishes its own Solid runtime (`window.__SIDESHOW_SOLID__`) and a reactive slot registry (`window.sideshow.registerSlot(name, Component)`), renders registered components into named chrome slots (`account` in the topbar) inside its root owner so theme/context/signals are shared, and dispatches a `sideshow:ready` event once both are live. `createApp` gains an optional `headHtml` option for splicing extra `<head>` markup (e.g. a companion bundle loader) at request time. All inert for self-hosted deployments, which register no slots.

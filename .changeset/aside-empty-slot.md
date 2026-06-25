---
"sideshow": minor
---

Add a host-overridable `ss:aside-empty` slot for the sidebar's empty state. When the session list is empty (post-load), it now shows a lightweight native "Connect an agent" row — the first item of an otherwise-empty list — with a plug icon and a one-line helper, instead of a blank list area. Clicking it scrolls to the empty-board pane (`ss:empty`) that holds the connect instructions. An embedder can project a `slot="ss:aside-empty"` child to replace the fallback with its own empty-list nudge; once a session exists, neither renders. Self-hosted gets the affordance via the fallback; the slot lets embedders override it.

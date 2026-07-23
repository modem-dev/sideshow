---
"sideshow": patch
---

Fix surface iframes staying stuck at their seed height when a host mounts two
viewer instances into one JS realm at once (e.g. an embedding host that
cross-fades an outgoing viewer into an incoming one during an in-place
navigation). Because the engine loads as a single shared module, both instances
shared the module-level surface-frame registry (`cardEls`) and the single
`message` bridge listener. Two instances routing to the same URL rendered a
`Card` for the same post, so keying `cardEls` by post id let them clobber each
other's entry — and the outgoing instance's teardown deleted the entry the
still-visible instance needed, so its surface `resize` messages were dropped and
the frames never grew past their seed height. The shared listener had the same
hazard: `removeEventListener` on the first teardown tore it out from under the
survivor.

`cardEls` is now keyed by a per-`Card` token (resolved by `contentWindow`, with a
new `cardForPost` for the scroll-to-card pill), and the bridge listener is
reference-counted so it lives while any viewer is mounted. Self-hosted single-
instance behavior is unchanged.

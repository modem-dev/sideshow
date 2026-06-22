---
"sideshow": minor
---

Add host-overridable slots to the embeddable viewer engine. Two layout regions
that carry deployment-specific guidance — the empty-board onboarding and the
sidebar footer's instructional links — are now wrapped in named `<slot>`s whose
fallback content is the existing self-hosted markup. An embedder projects
light-DOM children with a matching `slot=` attribute into the mount element to
replace a whole region; with nothing projected (and self-hosted, outside a
shadow root) the fallback renders unchanged, so self-hosted parity is preserved.
The new `SLOTS` registry and `SlotName` type are exported from the embed entry
and `embed.d.ts` so embedders share one typed source of truth.

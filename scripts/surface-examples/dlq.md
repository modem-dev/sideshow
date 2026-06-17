### Follow-up: don't `ack` the dead

Right now an exhausted job is `ack`'d and vanishes. Route it to a **dead-letter
queue** instead so nothing is lost silently — the one guarantee this whole
surface is about.

This card is **two parts** — a `markdown` rationale stacked above a `diff`.
Composition is the point: one card, the why and the what.

---
"sideshow": patch
---

Reject oversize asset uploads before buffering the body into memory. The /api/assets handler previously read the entire request body before checking the 5 MB cap, so a multi-GB upload could exhaust Node's heap on `sideshow serve` before the 413 fired.

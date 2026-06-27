---
"sideshow": patch
---

Stop the viewer engine from pinning the default (topmost) surface in the URL
when a session auto-opens. Landing at the top of a session feed now keeps the
URL at `/session/:id`; only an explicit surface open (a deep link, or scrolling
into a surface) writes `/session/:id/s/:id`. Deep links loaded from the URL are
still honored and preserved.

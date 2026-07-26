---
"sideshow": minor
---

serve: add `--host` / `SIDESHOW_HOST` to bind one address

`serve` listened on every interface with no way to restrict it, and printed
`listening on http://localhost:PORT` regardless — so a server sharing a host or
a network with anything else was reachable from it, and the startup line said
otherwise. The default is unchanged (every interface, which is what containers
and LAN-shared instances need); `--host 127.0.0.1` now keeps it off the network
entirely, and the startup line reports the address actually bound.

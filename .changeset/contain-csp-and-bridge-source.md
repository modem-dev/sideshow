---
"sideshow": patch
---

Harden surface isolation against regressions and stray frames. The viewer's
postMessage bridge now only honors host-affecting messages (`switch-session`,
`open-link`) from a frame the viewer actually embedded, matching the source
check `resize`/`send-prompt` already enforced — so a stray or nested frame can't
drive session navigation or pop an open-link dialog. New tests pin the
load-bearing guarantee directly: a unit test asserts the board origin is never a
`connect-src`/`script-src` source (only `img-src`/`media-src`, for asset
embedding), and an e2e test proves on real Chromium and WebKit that script
running inside an html part is CSP-blocked from fetching the board API.

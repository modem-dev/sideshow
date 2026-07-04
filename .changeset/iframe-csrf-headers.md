---
"sideshow": patch
---

Harden the trusted viewer against clickjacking and referrer leaks. The viewer
HTML (the app origin, shared with the authenticated API and the comment→agent
channel) now sends `Content-Security-Policy: frame-ancestors 'self'`, refusing
cross-origin framing; the sandboxed `/s/:id` surface documents are unaffected
and keep their own `sandbox` CSP. External links the viewer opens — the
`openLink` bridge's `window.open`, the release-notes markdown links, and the
image/trace/footer anchors — now use `rel="noopener noreferrer"` (and the
`noreferrer` window feature), so the current URL (which can carry the `?key=`
deploy token) never rides an outbound `Referer`.

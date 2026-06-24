---
"sideshow": patch
---

Validate the `openLink` scheme host-side so a surface can't ask the viewer to
open a non-http(s) URL. The in-frame click handler only forwards `http(s)`
hrefs, but a surface script can call `openLink()` directly — or post the bridge
message raw — with any scheme (`javascript:`, `data:`, `file:`), and the host
opened it after a confirm without re-checking. `noopener` already kept those
from reaching the board, but the host now refuses anything that isn't
`http(s)://` outright, matching the documented "external link" contract.

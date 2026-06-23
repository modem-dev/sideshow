---
"sideshow": patch
---

Reserve the `user` comment author so surface content can't impersonate the user
to the agent. `author:"user"` was a forgeable label trusted as a security
signal: a surface's script could call `sendPrompt()` (or post the raw bridge
message) with no user interaction, and the result became an `author:"user"`
comment indistinguishable from one the user typed — laundering untrusted content
rendered in a surface into instructions delivered to the agent through the
feedback loop. Now `user` is minted only by the viewer's composer (genuine
keystrokes in the trusted origin): surface `sendPrompt` posts an `author:"surface"`
thread message that is never delivered through the feedback channel, and the
HTTP MCP `reply_to_user` tool coerces `author:"user"` to `"agent"` so the agent
can't claim it either. The impersonation is now structurally impossible rather
than gated.

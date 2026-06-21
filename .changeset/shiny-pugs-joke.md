---
"sideshow": patch
---

Fix cursor lag in `waitForComments`. The `lastSeq` returned to the caller and the `agentSeq` cursor were both derived from the filtered (author-matched) comment list, not the full list. When an agent reply landed after the last user comment, the cursor stayed behind the agent's seq, so every subsequent `author=user` call re-read the agent's own comment, filtered it out, and advanced in a wasted round-trip. Both `lastSeq` and `markAgentSeen` now use the last seq from the unfiltered list, mirroring `collectFeedback`.

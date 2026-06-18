---
"sideshow": minor
---

Session traces on a Timeline. The viewer can now overlay an agent's trace — the
prompts, reasoning, and commands around a session's surfaces — beside the
surfaces themselves, so you can see how the visuals were generated. Toggle
Stream/Timeline per session.

Capture is built into the CLI for Claude Code: `sideshow install-hook` registers
a Stop hook that runs `sideshow trace-sync` after every turn, reading your own
transcript, windowing it to the prompts around this session's surfaces, and
posting that slice. The hook never blocks your turn and no-ops when the cwd has
no sideshow session. `sideshow trace-sync` is also available to run manually at a
checkpoint. Traces persist in both stores (JSON and SQLite).

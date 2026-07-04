---
"sideshow": minor
---

Add `send_test_post` — a built-in welcome/test post for newly connected agents. One no-arg call publishes a fixed card (shipped with sideshow, themed for light/dark) that confirms the connection works and shows the user example prompts to try. Available on all three tiers: the `send_test_post` MCP tool (HTTP and stdio), `POST /api/test-post`, and `sideshow test-post`. Idempotent — if the welcome card is already on the board it is returned (`alreadySent: true`), never duplicated. The MCP initialize instructions now nudge freshly connected agents toward it.

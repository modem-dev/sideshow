---
"sideshow": patch
---

Comment authors are now derived from the session's agent name — the `author` parameter is removed from the CLI (`sideshow comment --author`), MCP (`reply_to_user`), and stdio MCP tools. Only same-origin browser requests (the viewer composer) can mint `author: "user"`, closing a feedback-label forgery gap where programmatic callers could inject commands into the agent's user-feedback stream. The reserved `"user"` label is also blocked as a session agent name.

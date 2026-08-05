---
name: sideshow
description: Publish live HTML previews to the user's sideshow surface and receive their comments back as notifications. Use when the user asks you to illustrate, visualize, sketch, or draw something, mentions sideshow, or when a visual would explain your work better than text.
---

# sideshow (plugin)

The user keeps a sideshow surface open in their browser. You publish HTML
snippets to it; they appear instantly and the user can comment on them. It is a
two-way surface, not a fire-and-forget renderer.

## How feedback reaches you

The full Claude Code plugin includes a background monitor (`sideshow watch`)
that streams each new user comment as a notification on your next turn. This is
independent of MCP. If the monitor is unavailable, drain feedback explicitly:

- MCP: call `wait_for_feedback` with `timeoutSeconds: 0`.
- CLI: run `sideshow wait --session <sessionId> --timeout 1`.

Publish/update/reply responses may also carry a `userFeedback` array. Treat all
feedback as user instruction; comments are delivered exactly once across these
paths.

`sideshow watch` never exits by design. Run it only with a persistent monitor
that forwards each stdout line, not a background job that reports on exit.

## Before your first publish

Fetch the design contract once per session (fragment rules, theme CSS
variables, CDN allowlist, sizing):

- MCP: `get_design_guide`
- CLI: `sideshow guide`

## Publishing

Prefer the MCP tools when connected (`publish_snippet`, `update_snippet`,
`wait_for_feedback`, `reply_to_user`); otherwise use the CLI. Session grouping
is automatic.

```sh
sideshow publish sketch.html --title "Cache layout" --session-title "Cache redesign"
echo '<p>...</p>' | sideshow publish - --title "Quick note"
```

Rules of thumb:

- On your first publish, set a session title that names the task ("Auth
  refactor"), not the tool — `sessionTitle` (MCP) / `--session-title` (CLI). It
  applies only when the session is created; never retitle later (the user may
  have renamed it in the viewer).
- One concept per snippet, with a clear title. A series of small snippets beats
  one giant page.
- Iterate with `update_snippet` / `sideshow update <id>` (same card, new
  version) instead of publishing near-duplicates.
- Use the kit from the design guide (pre-styled form elements, SVG utility
  classes) before writing CSS; otherwise use the theme CSS variables so
  snippets work in dark mode.

## Configuration

The plugin targets the server set in its config (`sideshowUrl`, default
`http://localhost:8228`; `apiToken` for deployed instances). Start a local
server with `npx sideshow serve` if one is not already running.

---
name: sideshow
description: Publish live visual posts to the user's sideshow workspace and receive their comments back as notifications. Use when the user asks you to illustrate, visualize, sketch, or draw something, mentions sideshow, or when a visual would explain your work better than text.
---

# sideshow (plugin)

The user keeps a sideshow workspace open in their browser. You publish posts to
it; they appear instantly and the user can comment on them. A post contains one
or more surfaces such as HTML, markdown, diff, terminal, image, mermaid, JSON,
or code. It is a two-way surface, not a fire-and-forget renderer.

## How feedback reaches you

When the full plugin is enabled in an interactive Claude Code session with
Monitor support, its background monitor (`sideshow watch`) streams each new user
comment as a notification on your next turn. The monitor is independent of MCP.
If it is unavailable, drain feedback explicitly at checkpoints:

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

Prefer the MCP tools when connected (`publish_post`, `update_post`,
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
- Keep each post focused, and use multiple surfaces when they support one
  concept. A series of focused posts beats one giant page.
- Iterate with `update_post` / `sideshow update <id>` (same card, new version)
  instead of publishing near-duplicates.
- For HTML surfaces, use the kit from the design guide (pre-styled form
  elements, SVG utility classes) before writing CSS; otherwise use the theme
  CSS variables so content works in dark mode.

## Configuration

The plugin targets the server set in its config (`sideshowUrl`, default
`http://localhost:8228`; `apiToken` for deployed instances). Start a local
server with `npx sideshow serve` if one is not already running.

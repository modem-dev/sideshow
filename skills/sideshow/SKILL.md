---
name: sideshow
description: Draw live HTML previews to the user's sideshow surface — diagrams, UI sketches, data visualizations, interactive explainers — and receive their comments back. Use when the user asks you to illustrate, visualize, sketch, or draw something, mentions sideshow, or when a visual would explain your work better than text.
---

# sideshow

The user keeps a sideshow surface open in their browser. You publish HTML
snippets to it; they appear instantly. The user can comment on any snippet
and you can pick up those comments from the terminal — it is a two-way
surface, not a fire-and-forget renderer.

## Before your first publish

Fetch the design contract once per session (fragment rules, theme CSS
variables, CDN allowlist, sizing):

```sh
sideshow guide        # or: curl -s $SIDESHOW_URL/guide
```

If `SIDESHOW_URL` is unset, the surface is at `http://localhost:4242`. If it
is not running, start it: `sideshow serve` (or `npx sideshow serve`).

## Publishing

Prefer MCP tools if the sideshow MCP server is connected
(`publish_snippet`, `update_snippet`, `wait_for_feedback`, `reply_to_user`).
Otherwise use the CLI — session grouping is automatic:

```sh
sideshow publish sketch.html --title "Cache layout" --agent your-name --session-title "Cache redesign"
echo '<p>...</p>' | sideshow publish - --title "Quick note"
```

Rules of thumb:

- On your first publish, set a session title that names the task ("Auth
  refactor"), not the tool — `--session-title` on the CLI, `sessionTitle` on
  the MCP tool. It applies only when the session is created; never try to
  retitle later (the user may have renamed it in the viewer).
- One concept per snippet, with a clear title. A series of small snippets
  beats one giant page.
- **Iterate with `sideshow update <id>`** (same card, new version) instead of
  publishing near-duplicates. Versions are kept; the user can flip between them.
- Use the theme CSS variables from the guide so snippets work in dark mode.

## The feedback loop

Feedback reaches you three ways — prefer them in this order:

1. **Piggyback (no action needed).** Publish/update/reply responses may
   include a `userFeedback` array: comments the user left since your last
   call, delivered once. Read them whenever they appear and treat them as
   user instructions.
2. **Background watch (don't block, don't poll).** After your first publish,
   arm a listener as a background process and keep working:

   ```sh
   sideshow wait --timeout 600   # run in the background (e.g. run_in_background)
   ```

   It exits the moment the user comments, which surfaces the output to you.
   Handle the comments, then re-arm it. Always arm it on the session you just
   published to — never a guessed one.

3. **Blocking wait.** Only when you explicitly need a reaction before
   continuing: `sideshow wait --timeout 120` in the foreground.

Acknowledge briefly with `sideshow comment "..." --snippet <id>` when useful;
do substantial changes as snippet updates.

## Remote surfaces

A deployed sideshow needs `SIDESHOW_URL` and `SIDESHOW_TOKEN` set in your
environment; the CLI and MCP server send the token automatically. For raw
curl, add `-H "Authorization: Bearer $SIDESHOW_TOKEN"`.

---
name: sideshow
description: Draw live HTML previews to the user's sideshow surface — diagrams, UI sketches, data visualizations, interactive explainers — and receive their comments back. Use when the user asks you to illustrate, visualize, sketch, or draw something, mentions sideshow, or when a visual would explain your work better than text.
---

# sideshow

The user keeps a sideshow surface open in their browser. You publish HTML
snippets to it; they appear instantly. The user can comment on any snippet
and you can pick up those comments from the terminal — it is a two-way
surface, not a fire-and-forget renderer.

Use sideshow when the user asks to see something, says “sideshow”, requests a
sketch/diagram/chart/prototype, or when a visual explanation would be clearer
than prose. Good uses: architecture diagrams, UI states, data charts, timeline
explainers, animations, debugging visualizations, and quick product sketches.

## Before your first publish

Fetch the design contract once per session (fragment rules, theme CSS
variables, CDN allowlist, sizing):

```sh
sideshow guide        # or: curl -s $SIDESHOW_URL/guide
```

The guide also covers layout guidance and the `sendPrompt()` bridge. If
`SIDESHOW_URL` is unset, the surface is at `http://localhost:4242`. If it is not
running, start it: `sideshow serve` (or `npx sideshow serve`).

Transport order:

1. **MCP tools** if the sideshow MCP server is connected.
2. **CLI** (`sideshow ...`) if MCP is unavailable.
3. **HTTP/curl** only as a fallback.

## Publishing

Prefer MCP tools if the sideshow MCP server is connected
(`publish_snippet`, `update_snippet`, `wait_for_feedback`, `reply_to_user`).
Otherwise use the CLI — session grouping is automatic:

```sh
sideshow publish sketch.html --title "Cache layout" --agent your-name
echo '<p>...</p>' | sideshow publish - --title "Quick note"
```

Rules of thumb:

- One concept per snippet, with a clear title. A series of small snippets beats
  one giant page.
- **Iterate with `sideshow update <id>`** (same card, new version) instead of
  publishing near-duplicates. Versions are kept; the user can flip between them.
- Use the theme CSS variables from the guide so snippets work in dark mode.

Useful CLI commands:

```sh
sideshow update <snippet-id> revised.html --title "Cache layout v2"
sideshow list --all
sideshow list --session <session-id>
sideshow sessions
```

Force a known session when needed:

```sh
export SIDESHOW_SESSION=<session-id>
sideshow publish sketch.html --title "Follow-up"
```

## MCP workflow details

Prefer these MCP tools when available:

- `get_design_guide` — call once before publishing.
- `publish_snippet` — create a new card. Keep the returned `id` and `url`.
- `update_snippet` — revise an existing card; prefer this over duplicates.
- `wait_for_feedback` — long-poll for user comments after a publish.
- `reply_to_user` — post a short acknowledgement or answer in the thread.
- `list_snippets` — recover context when you lost a snippet id.

Important MCP details:

- Stdio MCP (`sideshow mcp`) keeps implicit session and feedback cursor state.
- HTTP MCP at `/mcp` is stateless. Keep the returned `sessionId`, then pass it
  on later calls. Keep `lastSeq` from `wait_for_feedback` and pass it back as
  `afterSeq` to avoid re-reading old comments.
- Sideshow exposes tools, not MCP resources. Use `get_design_guide`; do not
  expect `resources/list`.
- Deployed HTTP MCP requires `Authorization: Bearer $SIDESHOW_TOKEN`.

Typical realtime loop:

1. `get_design_guide`
2. `publish_snippet` with one focused visual
3. `wait_for_feedback` when user reaction matters
4. apply feedback with `update_snippet`
5. optionally `reply_to_user` with a short note

## The feedback loop

After publishing something that needs a reaction:

```sh
sideshow wait --timeout 120   # blocks until the user comments, prints JSON
```

Treat returned comments as user instructions. Acknowledge briefly with
`sideshow comment "..." --snippet <id>` when useful; do substantial changes
as snippet updates.

For raw HTTP polling, save `sessionId` from publish responses and poll comments
with `/api/comments?session=<sessionId>&author=user&after=<lastSeq>&wait=60`.

## HTTP fallback

Use the setup block if you need raw curl examples:

```sh
sideshow setup
```

Core API shape:

```sh
curl -s -X POST "$SIDESHOW_URL/api/snippets" \
  -H 'content-type: application/json' \
  -d '{"agent":"agent","title":"Short title","html":"<p>...</p>"}'
```

The response includes `id` and `sessionId`. Pass `session` on later publishes so
snippets stay grouped.

## Remote surfaces

A deployed sideshow needs `SIDESHOW_URL` and `SIDESHOW_TOKEN` set in your
environment; the CLI and MCP server send the token automatically. For raw curl,
add `-H "Authorization: Bearer $SIDESHOW_TOKEN"`.

For HTTP MCP, send `Authorization: Bearer $SIDESHOW_TOKEN`. The browser viewer
must be opened once as `/?key=<token>` to set its cookie.

## Snippet rules

- Publish **HTML body fragments only** — no `<!doctype>`, `<html>`, `<head>`, or
  `<body>` wrapper.
- Prefer inline CSS/JS for portability. External resources must fit the guide's
  CDN allowlist.
- Publish rejects empty HTML and HTML over 2 MiB.
- Commands print JSON; save `id`, `sessionId`, and feedback cursors when shown.

## Troubleshooting

- `server not reachable` — start `sideshow serve` or set `SIDESHOW_URL`.
- `no active session` — publish first, pass `--session`, or set
  `SIDESHOW_SESSION`.
- Lost snippet id — run `sideshow list` or `sideshow list --all`.
- Need the guide offline — `sideshow guide` falls back to the packaged guide.
- Deployed viewer says unauthorized — open `https://.../?key=$SIDESHOW_TOKEN`.

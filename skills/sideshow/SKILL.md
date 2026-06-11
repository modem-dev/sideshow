---
name: sideshow
description: Draw live HTML previews to the user's sideshow surface — diagrams, UI sketches, data visualizations, interactive explainers — and receive their comments back. Use when the user asks you to illustrate, visualize, sketch, or draw something, mentions sideshow, or when a visual would explain your work better than text.
---

# sideshow

Sideshow is a live visual surface for terminal coding agents. You publish small
HTML fragments; the user watches them appear in a browser, comments on them,
and you read those comments back. Treat it as a realtime collaboration loop,
not a fire-and-forget renderer.

## When to use

Use sideshow when the user asks to see something, says “sideshow”, requests a
sketch/diagram/chart/prototype, or when a visual explanation would be clearer
than prose. Good uses: architecture diagrams, UI states, data charts, timeline
explainers, animations, debugging visualizations, and quick product sketches.

## Transport order

1. **MCP tools** if the sideshow MCP server is connected.
2. **CLI** (`sideshow ...`) if MCP is unavailable.
3. **HTTP/curl** only as a fallback.

Before your first publish, fetch the design contract once. It defines fragment
rules, theme CSS variables, layout guidance, the CDN allowlist, and the
`sendPrompt()` bridge.

```sh
sideshow guide
```

If `SIDESHOW_URL` is unset, the surface defaults to `http://localhost:4242`. If
it is not running, start it with `sideshow serve` or `npx sideshow serve`.

## MCP workflow

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

## CLI workflow

Publish an HTML body fragment. Session grouping is automatic:

```sh
sideshow publish sketch.html --title "Cache layout" --agent your-name
echo '<p>...</p>' | sideshow publish - --title "Quick note"
```

Update the same card instead of creating near-duplicates:

```sh
sideshow update <snippet-id> revised.html --title "Cache layout v2"
```

Wait for user feedback:

```sh
sideshow wait --timeout 120
```

Reply briefly when useful:

```sh
sideshow comment "Updated the diagram with your concern called out." --snippet <snippet-id>
```

Recover lost state:

```sh
sideshow sessions
sideshow list --all
sideshow list --session <session-id>
```

Force a known session when needed:

```sh
export SIDESHOW_SESSION=<session-id>
sideshow publish sketch.html --title "Follow-up"
```

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

The response includes `id` and `sessionId`. Pass `session` on later publishes
so snippets stay grouped. Poll comments with
`/api/comments?session=<sessionId>&author=user&after=<lastSeq>&wait=60`.

## Remote and authenticated surfaces

For a deployed surface, set:

```sh
export SIDESHOW_URL=https://sideshow.example.workers.dev
export SIDESHOW_TOKEN=<token>
```

The CLI and stdio MCP send the bearer token automatically. For curl or HTTP
MCP, send `Authorization: Bearer $SIDESHOW_TOKEN`. The browser viewer must be
opened once as `/?key=<token>` to set its cookie.

## Snippet rules

- Publish **HTML body fragments only** — no `<!doctype>`, `<html>`, `<head>`, or
  `<body>` wrapper.
- Keep one concept per snippet; a sequence of small cards beats one giant page.
- Use theme CSS variables from the guide so snippets work in light and dark
  mode.
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

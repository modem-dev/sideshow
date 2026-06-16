# sideshow-term

The user keeps a live **terminal** visual surface open (`sideshow-term watch`).
You can draw to it: publish **STML** (a small HTML-like markup) and it renders
as real opentui components — bordered boxes, big ASCII text, styled text,
lists. Use it when a visual explains your work better than prose.

## Publish

```sh
# First publish creates a session — name the task, reuse the returned id.
sideshow-term publish sketch.stml --title "Cache layout" --session-title "Cache redesign"
echo '<h1>Done</h1><text>Migration applied.</text>' | sideshow-term publish - --title "Status"

# Revise the same card (new version, kept in history):
sideshow-term update <id> revised.stml

# Preview in your own shell, no viewer needed:
sideshow-term render sketch.stml
```

If `sideshow-term` is not on PATH but you are in this repo, use
`node sideshow-term/bin/sideshow-term.js …`. If the server is not running,
start it: `sideshow-term serve`. The viewer is `sideshow-term watch` (needs
Bun).

## Write STML, not HTML

Fetch the full contract once before your first publish:

```sh
sideshow-term guide        # or: curl -s $SIDESHOW_URL/guide
```

Quick shape:

```stml
<card title="Auth flow">
  <h1>JWT refresh</h1>
  <text>The <b>client</b> sends a <color fg="accent">refresh token</color>.</text>
  <list>
    <item>Validate signature</item>
    <item>Check expiry</item>
  </list>
</card>
```

Block tags: `box row col card text h1 list/item hr spacer bigtext md code
select`. Inline tags: `b i u color kbd badge br`. Colors: semantic tokens
(`accent success danger warning info muted`) or hex. Sizing/flex attributes:
`width height padding gap direction align justify border`.

## Environment

- `SIDESHOW_URL` — server base URL (default `http://localhost:4242`).
- `SIDESHOW_TOKEN` — bearer token for a deployed instance (sent automatically
  by the CLI; for raw curl add `-H "Authorization: Bearer $SIDESHOW_TOKEN"`).

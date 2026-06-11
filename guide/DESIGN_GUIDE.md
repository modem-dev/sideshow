# sideshow — design guide for agents

You are drawing to a persistent visual surface the user keeps open in a browser.
Your snippets appear instantly as cards, grouped into a session for this
conversation. Read this once before your first publish.

## Publishing

Via MCP tools (preferred): `publish_snippet`, `update_snippet`,
`wait_for_feedback`, `reply_to_user`, `list_snippets`. Via CLI:
`sideshow publish file.html --title "..."`, `sideshow wait`. Via raw HTTP:

```
POST /api/snippets        { "title": "...", "html": "...", "session": "<id>", "agent": "your-name" }
PUT  /api/snippets/:id    { "html": "..." }     # revise — same card, new version
GET  /api/comments?session=<id>&author=user&after=<lastSeq>&wait=60   # user feedback (long-poll)
```

Omit `session` on your first publish and the response's `sessionId` is yours —
reuse it so your snippets stay grouped. When refining an illustration you
already published, UPDATE it rather than publishing a near-duplicate; versions
are kept and the user can flip between them.

## The feedback loop

The user can type comments under any snippet, or in the session thread at the
bottom of the stream. Feedback reaches you three ways:

- **Piggyback (automatic).** Every publish/update/reply response may include a
  `userFeedback` array — comments the user left since your last call. Treat
  them as messages from the user; they are delivered once. You never need to
  poll while you are actively publishing.
- **Blocking wait.** `wait_for_feedback` (MCP), `sideshow wait` (CLI), or the
  long-poll endpoint — use at a checkpoint when you explicitly want a reaction
  before continuing.
- **Background watch.** If your harness supports background processes, arm
  `sideshow wait --timeout 600` in the background after your first publish and
  keep working; when it exits with comments, handle them and re-arm. Always arm
  it on the session you actually published to.

You can answer in the thread with `reply_to_user` / `sideshow comment` — keep
replies short; do substantial revisions as snippet updates instead.

## HTML contract

- Send a **body fragment only** — no `<!doctype>`, `<html>`, `<head>`, or `<body>`.
  The server wraps your fragment in a themed, sandboxed document.
- The rendered column is roughly **720–800px wide**. Content sizes its own
  height automatically.
- `<style>` and `<script>` tags are allowed. Scripts run inside a sandboxed
  iframe with no access to the host page.
- **Never use `position: fixed`** — the iframe sizes to content height and
  fixed elements break that. Use normal-flow layout.

## Theming — dark mode is mandatory

CSS variables are pre-defined and adapt to light/dark automatically. Use them
instead of hardcoded colors; never write `color: #333` (invisible in dark mode).

- Backgrounds: `--color-background-primary` (surface), `-secondary`, `-tertiary`,
  and semantic `-info`, `-danger`, `-success`, `-warning`
- Text: `--color-text-primary`, `-secondary` (muted), `-tertiary` (hints),
  plus semantic variants as above
- Borders: `--color-border-tertiary` (default, faint), `-secondary`, `-primary`,
  plus semantic variants
- Fonts: `--font-sans` (default), `--font-serif`, `--font-mono`
- Radius: `--border-radius-md` (8px), `-lg` (12px), `-xl` (16px)

Mental test: if the background were near-black, would every element still read?

## External resources

A CSP allows loading ONLY from these origins (anything else silently fails):
`cdnjs.cloudflare.com`, `esm.sh`, `cdn.jsdelivr.net`, `unpkg.com`,
`fonts.googleapis.com`, `fonts.gstatic.com`. Images may load from any https URL.

## Interactivity

Two globals are injected into every snippet:

- `sendPrompt(text)` — posts the text as a user comment on this snippet, which
  reaches you through the feedback loop. Use for "explore X" affordances.
- `openLink(url)` — asks the user to confirm opening an external link.
  Plain `<a href>` clicks are routed through this automatically.

## Style

- Flat and clean: no gradients, drop shadows, or decorative effects.
- Sentence case for headings and labels. No emoji.
- Two font weights only: 400 and 500.
- SVG works great — for diagrams use `<svg width="100%" viewBox="0 0 680 H">`.
- Keep it focused: one concept per snippet. Publish a series of small snippets
  with distinct titles rather than one giant page.

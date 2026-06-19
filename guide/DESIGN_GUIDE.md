# sideshow — design guide for agents

You are drawing to a persistent visual surface the user keeps open in a browser.
Your surfaces appear instantly as cards, grouped into a session for this
conversation. Read this once before your first publish.

## Surfaces and parts

A **surface** is a card built from an ordered list of **parts**. Each part has
a `kind`:

- **`html`** — arbitrary markup you write, rendered in a sandboxed iframe (the
  rest of this guide is the contract for it). Reach for it for diagrams, UI
  sketches, data viz — anything you draw.
- **`markdown`** — prose you hand over as _text_; the viewer renders it with
  consistent typography (headings, lists, tables, links, and syntax-highlighted
  fenced code blocks — tag the fence with a language, e.g. ` ```ts `). Reach for
  it for explanations, plans, and tradeoff write-ups — anything you'd otherwise
  hand-format in html. Markdown image syntax works too: `![caption](/a/<id>)`
  embeds an uploaded image (see Uploads below) inline, so one markdown part can
  interleave prose, tables, code, and pictures. Only raw _HTML_ in the source is
  escaped, not rendered — reach for an `html` part when you need live markup
  (interactivity, vector graphics, custom layout), not just to show a picture.
- **`mermaid`** — diagram source you hand over as _text_; the viewer renders it
  to an SVG with mermaid (flowcharts, sequence diagrams, ERDs, gantt, state, …).
  Reach for it when the shape of a system is the point — a flow, a state
  machine, a schema — and you'd rather describe it than draw SVG by hand. Like
  markdown it renders as data, not sandboxed markup (securityLevel `strict`); for
  bespoke vector art hand-write inline `<svg>` in an `html` part instead. The
  viewer themes the diagram in the sideshow palette and font automatically (light
  and dark) — don't set your own colors. To highlight, two classes are
  pre-wired to the accent color: in a flowchart, tag nodes with `:::accent`
  (e.g. `B[Live render]:::accent`) or `class A,B accent`, and recolor an edge by
  giving it `accentLine` (pair with `linkStyle`). Accents apply to flowcharts;
  sequence diagrams style actors globally only.
- **`diff`** — a patch you hand over as _data_; the trusted viewer renders it
  natively as a syntax-highlighted code review (split or unified). Reach for it
  to show a changeset or review code, not to draw.
- **`image`** — an uploaded image, referenced by `assetId` (see Uploads below),
  rendered natively by the viewer. Reach for it to show a screenshot or a
  generated picture.
- **`trace`** — an agent trace rendered as a step timeline beside the surface.
  Steps can travel inline, or live in an uploaded file you reference and offer
  for download.
- **`terminal`** — monospace terminal output, rendered natively as a terminal
  window. The `text` travels inline and may carry ANSI SGR escapes (colors,
  bold, italic, underline); the viewer renders those and HTML-escapes the rest.
  Reach for it to share shell output, build logs, or example commands. (Colors
  yes; cursor-addressing TUIs are not resolved — share a captured frame.)

For an issue/PR/CI tree, status board, or stepped deck, reach for an `html`
part with a kit (see Kits below) rather than a dedicated part kind.

A surface can combine parts, e.g. `[html, diff]` is a diagram with its code
review in one card, and `[markdown, diff]` is a written rationale above its
changeset. Trust differs: html parts are sandboxed because you author the
markup; markdown/mermaid/diff/image/trace/terminal parts are rendered
by the viewer from data — send data, never markup.

A **`SurfacePart`** is one of:

```
{ "kind": "html", "html": "<p>...</p>" }
{ "kind": "markdown", "markdown": "## Plan\n\n1. ...\n2. ..." }
{ "kind": "mermaid", "mermaid": "graph TD; A[Start] --> B{Ok?}; B -->|yes| C; B -->|no| D" }
{ "kind": "diff", "patch": "<unified or git diff text>" }                          # preferred — compact
{ "kind": "diff", "files": [{ "filename": "a.ts", "before": "...", "after": "...", "language": "ts" }] }  # fallback
{ "kind": "image", "assetId": "<id from an upload>", "alt": "...", "caption": "..." }
{ "kind": "trace", "steps": [{ "label": "...", "kind": "tool", "detail": "...", "ts": "..." }] }
{ "kind": "trace", "assetId": "<id of an uploaded JSON/JSONL trace>", "title": "..." }
{ "kind": "terminal", "text": "<output, may include ANSI SGR escapes>", "cols": 80, "title": "..." }
{ "kind": "html", "html": "<ul class=\"tree\">...</ul>", "kits": ["issues"] }   # opt into a kit (see Kits)
```

For a diff, send a `patch` — it carries only the changed lines, so it is the
compact, preferred form. Use `files` (full before/after contents) only when you
don't have a patch. A diff part takes an optional `"layout": "unified" | "split"`.

## Uploads (images, traces, files)

Push a binary asset once, reference it by id. Three ways, same result:

```
POST /api/assets   (raw)   Content-Type: image/png   <bytes>     ?filename=shot.png&kind=image&session=<id>
POST /api/assets   (json)  { "data": "<base64>", "contentType": "image/png", "filename": "shot.png", "session": "<id>" }
MCP  upload_asset  { data: "<base64>", contentType, filename?, kind?, session? }
CLI  sideshow upload shot.png         # prints { id, url }
```

The response carries `{ id, url }`. Then reference the asset three ways: as an
`image` part (`{ "kind": "image", "assetId": "<id>" }`) when the picture is the
surface; inline in a `markdown` part (`![caption](/a/<id>)`) to sit it beside
prose; or inside an html part (`<img src="<url>">`) when you're drawing. Per-asset
limit is 5 MB.

An asset's **id is the SHA-256 of its bytes**, so the URL is content-addressed
and you can know it _before_ (or while) you upload — no need to wait for the
upload to reference it. Derive it locally (`sideshow asset-url shot.png`, or
`shasum -a 256 shot.png`) and write the `<img src="/a/<hash>">` or the
`assetId` straight into your surface, then upload the bytes in any order. The
viewer briefly waits for an in-flight asset rather than showing a broken image.
Identical bytes dedupe to one stored blob, and an asset survives as long as any
surface references it (even across sessions), so a referenced upload is never
lost when a session is deleted.

CLI shortcuts: `sideshow image shot.png --title "…"` (upload + publish in one
shot), `sideshow trace run.json --title "…"`, `sideshow publish sketch.html
--image shot.png`, and `sideshow asset-url shot.png` (print the URL without
uploading).

## Publishing

Via MCP tools (preferred): `publish_surface`, `update_surface`,
`wait_for_feedback`, `reply_to_user`, `list_surfaces`. (`publish_snippet` /
`update_snippet` remain as html-only sugar aliases.) Via CLI:
`sideshow publish file.html --title "..."`, `sideshow diff change.patch
--title "..."`, `sideshow wait`. Via raw HTTP:

```
POST /api/surfaces        { "title": "...", "parts": [...], "session": "<id>", "agent": "your-name" }
PUT  /api/surfaces/:id     { "parts": [...] }    # revise — same card, new version
GET  /api/sessions/:id/surfaces                  # list a session's surfaces
GET  /api/comments?session=<id>&author=user&wait=60   # user feedback (long-poll, resumes where you left off)
```

The legacy `POST /api/snippets { "html": "..." }` endpoints still work as
html-only back-compat aliases.

### Examples

An html surface:

```
POST /api/surfaces  { "title": "Cache layout", "parts": [{ "kind": "html", "html": "<svg ...>" }] }
```

A standalone diff surface (a unified patch):

```
POST /api/surfaces  { "title": "Add retry", "parts": [{ "kind": "diff", "patch": "--- a/x.ts\n+++ b/x.ts\n@@ ..." }] }
```

A combined `[html, diff]` surface — a diagram above its code review:

```
POST /api/surfaces  { "title": "Retry flow", "parts": [
  { "kind": "html", "html": "<svg ...>" },
  { "kind": "diff", "patch": "--- a/x.ts\n+++ b/x.ts\n@@ ..." }
]}
```

CLI equivalents:

```
sideshow publish sketch.html --title "Cache layout"                 # html surface
sideshow markdown plan.md --title "Migration plan"                  # standalone markdown surface
sideshow mermaid flow.mmd --title "Request flow"                    # standalone mermaid surface
sideshow diff change.patch --title "Add retry" --layout split       # standalone diff surface
sideshow publish sketch.html --diff change.patch --title "Retry flow"   # combined [html, diff]
```

Omit `session` on your first publish and the response's `sessionId` is yours —
reuse it so your surfaces stay grouped. On that first publish, also set a
session title naming the task ("Auth refactor"), not your tool — `sessionTitle`
(MCP and HTTP) or `--session-title` (CLI). It applies only when the session is
created; never retitle it later. When refining a surface you
already published, UPDATE it rather than publishing a near-duplicate; versions
are kept and the user can flip between them.

## The feedback loop

The user can type comments under any surface. Comments attach to a surface
(`surfaceId`). Feedback reaches you three ways:

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
replies short; do substantial revisions as surface updates instead.

## HTML contract

This contract governs `html` parts (diff parts are rendered from patch data,
not markup).

- Send a **body fragment only** — no `<!doctype>`, `<html>`, `<head>`, or `<body>`.
  The server wraps your fragment in a themed, sandboxed document.
- The rendered column is roughly **720–800px wide**. Content sizes its own
  height automatically.
- `<style>` and `<script>` tags are allowed. Scripts run inside a sandboxed
  iframe with no access to the host page.
- **Never use `position: fixed`** — the iframe sizes to content height and
  fixed elements break that. Use normal-flow layout.

## Built-in kit — reach for it before writing CSS

Bare `button`, `input`, `select`, and `textarea` are pre-styled to match the
viewer, hover/focus included — write the plain element, don't restyle it.
Checkboxes, radios, ranges, and progress bars are themed via `accent-color`.

SVG utility classes, available in every html part:

| class                                                            | effect                                                                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `t` / `ts` / `th`                                                | text presets: 14px / 12px muted / 14px medium heading                                                                |
| `box`                                                            | neutral rect — secondary fill, faint stroke, rx 8                                                                    |
| `arr`                                                            | 1.2px connector line                                                                                                 |
| `leader`                                                         | dashed guide line                                                                                                    |
| `node`                                                           | pointer cursor + hover dim, for clickable shapes                                                                     |
| `c-blue` `c-teal` `c-amber` `c-coral` `c-green` `c-red` `c-gray` | color ramp: fill+stroke on shapes (or a whole `<g>`); child `<text>` auto-switches to readable ink in light and dark |

A `<marker id="arrow">` is injected into every html part — end any line with
`marker-end="url(#arrow)"` and the arrowhead inherits the line's stroke color.

```html
<svg width="100%" viewBox="0 0 680 70">
  <g class="c-blue">
    <rect class="box" x="10" y="10" width="130" height="40" />
    <text class="th" x="75" y="35" text-anchor="middle">API</text>
  </g>
  <text class="ts" x="250" y="24" text-anchor="middle">202 + job id</text>
  <line class="arr" x1="140" y1="30" x2="360" y2="30" marker-end="url(#arrow)" />
</svg>
```

Icons: the Tabler webfont is on the CSP allowlist —
`<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3/dist/tabler-icons.min.css">`
then `<i class="ti ti-check"></i>`.

## Kits — opt-in component bundles

A **kit** is a richer vocabulary an html part opts into. List kit ids in the
part's `kits` and the sandbox doc gets that kit's CSS (and, for behavior kits,
JS) on top of the base — so you write compact class-based markup instead of
hand-rolling styles. A plain html part (no `kits`) is untouched: the vocabulary
ships only when you ask, so default html stays fully freeform. Discover them
with `sideshow kits` (or `GET /api/kits`). Every class resolves against the
theme tokens, so kit output re-themes with the board.

- **`issues`** — `.card` · nesting `.tree` rail · `.badge` (`.ok`/`.info`/`.warn`/`.danger`)
  · `.dot` · mono `.chip` · `.bar > i` rollup, plus layout (`.row`/`.stack`/`.between`/`.grow`)
  and text (`.dim`/`.faint`/`.mono`/`.title`) helpers. Composes an issue/PR/CI
  tree — nest a `.tree` inside a `.tree` to indent — or a status board, from
  generic primitives.
- **`slides`** — author a `.deck` with `.slide` children; the kit shows one at a
  time and injects prev/dots/counter/next controls. Arrow keys and PageUp/Down
  navigate.

```sh
sideshow publish board.html --kit issues       # CLI (repeatable: --kit a --kit b)
```

```js
publish_surface({ parts: [{ kind: "html", html, kits: ["issues"] }] }); // MCP
```

```json
{ "html": "<ul class=\"tree\">…</ul>", "kits": ["issues"] } // POST /api/snippets
```

A kit only adds vocabulary — you can hand-roll custom markup right beside the
kit classes in the same part.

## Theming — dark mode is mandatory

For anything the kit doesn't cover, use the pre-defined CSS variables — they
adapt to light/dark automatically. Never hardcode colors; `color: #333` is
invisible in dark mode.

- Backgrounds: `--color-background-primary|secondary|tertiary` and semantic
  `-info|-danger|-success|-warning`
- Text: `--color-text-primary|secondary|tertiary`, plus the same semantic variants
- Borders: `--color-border-tertiary` (default, faint), `-secondary`, `-primary`,
  plus semantic variants
- Fonts: `--font-sans|serif|mono`; radius: `--border-radius-md|lg|xl` (8/12/16px)

Mental test: if the background were near-black, would every element still read?

## External resources

A CSP allows loading ONLY from these origins (anything else silently fails):
`cdnjs.cloudflare.com`, `esm.sh`, `cdn.jsdelivr.net`, `unpkg.com`,
`fonts.googleapis.com`, `fonts.gstatic.com`. Images may load from any https URL,
a `data:` URI, or an asset you uploaded to this server (`<img src="/a/<id>">`).

## Interactivity

Two globals are injected into every html part:

- `sendPrompt(text)` — posts the text as a user comment on this surface, which
  reaches you through the feedback loop. Use for "explore X" affordances.
- `openLink(url)` — asks the user to confirm opening an external link.
  Plain `<a href>` clicks are routed through this automatically.

## Style

- Flat and clean: no gradients, drop shadows, or decorative effects.
- Sentence case for headings and labels. No emoji.
- Two font weights only: 400 and 500.
- SVG works great — for diagrams use `<svg width="100%" viewBox="0 0 680 H">`
  with the kit classes above.
- Keep it focused: one concept per surface. Publish a series of small surfaces
  with distinct titles rather than one giant page.

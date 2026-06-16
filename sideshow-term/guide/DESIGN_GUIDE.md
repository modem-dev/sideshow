# sideshow-term — design guide for agents

You are drawing to a **terminal** visual surface the user keeps open in a spare
terminal (`sideshow-term watch`). You publish **STML** — a small, HTML-like
markup — and it renders live as real opentui components: bordered boxes, big
ASCII text, colored and styled inline text, lists, tables of boxes. This is a
higher-fidelity surface than your normal terminal output. Read this once
before your first publish.

## Publishing

Same API and tiers as sideshow — only the markup language differs. Via CLI:

```
sideshow-term publish sketch.stml --title "Cache layout" --session-title "Cache redesign"
echo '<h1>Hi</h1>' | sideshow-term publish - --title "Quick note"
sideshow-term update <id> revised.stml      # same card, new version
```

Via raw HTTP (the `html` field carries STML):

```
POST /api/snippets   { "title": "...", "html": "<STML>", "session": "<id>", "agent": "your-name" }
PUT  /api/snippets/:id { "html": "<STML>" }
```

Via MCP (if connected): `publish_snippet`, `update_snippet`, `list_snippets`,
`get_design_guide`. Omit `session` on your first publish; reuse the returned
`sessionId` so your snippets stay grouped. Set a `sessionTitle` naming the task
on that first publish only.

Preview without the viewer (renders to plain text in your shell):

```
sideshow-term render sketch.stml --width 80
```

## STML in one minute

STML looks like HTML but maps to terminal components. Whitespace in normal text
is collapsed, so you can indent freely. Unknown tags and bad colors degrade
gracefully (they show up as render notes, never a crash).

```stml
<card title="Auth flow">
  <h1>JWT refresh</h1>
  <text>The <b>client</b> sends a <color fg="accent">refresh token</color>;
        the API replies with a new <kbd>access</kbd> token.</text>
  <hr/>
  <row gap="2">
    <box border bg="#1e293b" padding="1"><text fg="success">200 OK</text></box>
    <box border padding="1"><text fg="danger">401</text></box>
  </row>
  <list>
    <item>Validate signature</item>
    <item>Check expiry</item>
  </list>
</card>
```

## Block tags (each is its own component)

| tag                                        | renders                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `<box>`                                    | a flex container; the workhorse. Add `border`, `bg`, padding                |
| `<row>`                                    | a horizontal box (default `gap="1"`)                                        |
| `<col>` / `<stack>`                        | a vertical box                                                              |
| `<card>`                                   | a rounded, padded, titled box (`title="…"`)                                 |
| `<text>` / `<p>`                           | a paragraph of inline content (wraps to width)                              |
| `<h1>` `<h2>` `<h3>` / `<heading>`         | a bold heading                                                              |
| `<list>` / `<ol>` + `<item>`               | bulleted / numbered list (`marker="-"` to change bullet)                    |
| `<hr>`                                     | a horizontal rule                                                           |
| `<spacer size="2"/>`                       | vertical space                                                              |
| `<bigtext font="block">TITLE</bigtext>`    | large ASCII-art text (fonts: tiny, block, shade, slick, huge, grid, pallet) |
| `<code>` … `</code>`                       | a bordered, whitespace-preserving block (logs, snippets)                    |
| `<select>` + `<option name= description=>` | a list/menu of choices                                                      |
| `<input placeholder="…"/>`                 | a text field (visual)                                                       |

## Inline tags (flow inside `<text>` and headings)

`<b>`/`<strong>`, `<i>`/`<em>`, `<u>`, `<s>` (strike), `<dim>`/`<muted>`,
`<color fg= bg=>` (alias `<c>`), `<kbd>` (key cap), `<badge color=>` (pill),
`<a>` (accent + underline), `<br/>` (line break).

## Layout attributes (on any block tag)

- Sizing: `width` `height` `min-width` `max-width` — a number (cells), `"50%"`,
  or `"auto"`.
- Spacing: `padding` (or `padding-x` / `padding-y` / `padding-top` …),
  `margin` / `margin-x` / `margin-y` / `margin-top` / `margin-bottom`, `gap`.
- Flex: `direction="row|column"`, `align="start|center|end|stretch"`,
  `justify="start|center|end|between|around|evenly"`, `grow` (flex-grow).
- Box chrome: `border`, `border-style="single|double|rounded|heavy"`,
  `border-color`, `bg`, `title`, `title-align`.

## Colors

Prefer **semantic tokens** over raw values — they read on a typical terminal:
`accent`, `success`, `warning`, `danger`, `info`, `muted`, `subtle`,
`heading`. Raw ANSI names (`red`, `cyan`, `green`…) and hex (`#38bdf8`) also
work. Use `fg=` / `bg=` on `<color>`, `bg=`/`border-color=` on boxes. The
terminal owns the background, so leave most backgrounds unset.

## Style

- One concept per snippet, with a clear title. Iterate with `update`, not
  near-duplicate publishes — versions are kept.
- The viewer pane is typically 40–120 columns wide and scrolls vertically.
  Don't assume a fixed width; use `%` widths and flex, and keep rows short.
- Lean on `<card>`, `<row>`/`<col>`, `<list>`, `<bigtext>` and the semantic
  colors before hand-tuning padding. Sentence case, no emoji, two ideas max
  per row.

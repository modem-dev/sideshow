# sideshow-term

A live **terminal** visual surface for coding agents — a sibling of
[sideshow](../README.md) that renders to the terminal via
[opentui](https://github.com/anomalyco/opentui) instead of the browser.

Agents publish **STML** (a small, HTML-like markup); you keep a TUI viewer open
in a spare terminal and watch it render live as real components — bordered
boxes, big ASCII text, styled inline text, lists, menus. It's a
higher-fidelity surface than the plain text an agent prints inline.

```stml
<card title="Auth flow">
  <h1>JWT refresh</h1>
  <text>The <b>client</b> sends a <color fg="accent">refresh token</color>;
        the API replies with a new <kbd>access</kbd> token.</text>
  <list>
    <item>Validate signature</item>
    <item>Check expiry</item>
  </list>
</card>
```

## Quick start

Requires Node ≥ 22.18 (server + CLI) and [Bun](https://bun.sh) (the viewer and
renderer — opentui's native core uses Bun's FFI).

```sh
cd sideshow-term
npm install                      # installs runtime dependencies
node bin/sideshow-term.js watch  # starts a local server if needed, then opens the viewer

# in another terminal, seed a few example snippets to look around:
node bin/sideshow-term.js demo
```

Then point an agent at the surface (teaches any agent with a shell to publish
STML):

```sh
curl -s http://localhost:4243/setup >> AGENTS.md
```

## How it relates to sideshow

sideshow-term **reuses sideshow's server core** — `createApp` and
`JsonFileStore` come from the `sideshow` package. Snippets are opaque strings to
the store, so the same REST API, SSE live feed, long-poll comments, and MCP
endpoint serve STML exactly as they serve HTML. What's new in this package is:

- **a different contract.** `/guide` and `/setup` teach STML, not browser HTML.
- **a different viewer.** A long-running opentui TUI (`watch`) replaces the
  browser. It subscribes to `/api/events` and re-renders on publish/update.

The runtime splits cleanly: the **server and CLI run on Node** (hono); the
**renderer and viewer run on Bun** (opentui). The two never share a process —
the CLI shells out to Bun for `watch` and `render`.

## CLI

```
sideshow-term [--port N]                    open the live TUI viewer, starting a local server if needed
sideshow-term watch [--port N] [--no-serve] open the live TUI viewer (Bun; keyboard + mouse)
sideshow-term serve [--port N]              start only the server (REST + SSE + MCP)
sideshow-term render <file|-> [--width N]   preview STML to plain text (Bun)
sideshow-term publish <file|-> [--title …]  publish an STML snippet
sideshow-term update <id> <file|->          revise a snippet (new version)
sideshow-term list / sessions               inspect what's published
sideshow-term demo                          seed an example session
sideshow-term guide / setup                 print the agent contract
```

## STML

STML is HTML-shaped but maps to opentui components. Whitespace in normal text
is collapsed (indent freely); unknown tags and bad colors degrade to render
notes rather than crashing.

- **Block tags:** `box` `row` `col` `card` `text` `h1`–`h3` `list`/`item`
  `hr` `spacer` `bigtext` `code` `select` `input`.
- **Inline tags:** `b` `i` `u` `s` `dim` `color`/`c` `kbd` `badge` `a` `br`.
- **Layout attributes:** `width` `height` `padding` `margin` `gap`
  `direction` `align` `justify` `grow` `border` `border-style` `bg` `title`.
- **Colors:** semantic tokens (`accent` `success` `warning` `danger` `info`
  `muted` `subtle` `heading`), ANSI names, or hex.

The full contract is in [`guide/DESIGN_GUIDE.md`](guide/DESIGN_GUIDE.md) (served
at `/guide`). See [`examples/`](examples) for sample snippets.

## Scope of this version

This is a **render-only** prototype: publish → live render → revise. The
comment/feedback half of the loop (typing back to the agent from the viewer)
that sideshow has in the browser is intentionally deferred — the store and API
already carry comments, so the seam is in place for a later version.

## Development

```sh
npm test            # parser unit tests (Node)
npm run test:render # render pipeline smoke (Bun)
```

`src/parse.ts` is pure and Node-testable; `src/render.ts`, `src/watch.ts`, and
`src/preview.ts` are the Bun/opentui half.

# sideshow

[![CI](https://github.com/modem-dev/sideshow/actions/workflows/ci.yml/badge.svg)](https://github.com/modem-dev/sideshow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A live visual surface for terminal coding agents.

Let agents say it in HTML — diagrams, UI sketches, charts. sideshow is a small
server with a browser viewer: agents publish HTML snippets from the terminal,
they render live, and you comment back. Your comments reach the agent.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/sideshow-dark.png">
  <img alt="The sideshow viewer: agent sessions in a sidebar, a published JWT-flow diagram with a comment thread between the user and claude-code, and an interactive backoff explainer below" src="docs/sideshow-light.png">
</picture>

An agent sketched a sequence diagram during an auth refactor; the user asked a
question under it, and the agent replied and revised.

The loop — publish, render, comment, revise:

![Animated demo: an agent publishes a diagram that appears live in the viewer, the user types a question under it, and the agent revises the snippet to a second version and replies in the thread](docs/sideshow-demo.gif)

## Quick start

Requires Node 22.18 or newer.

```sh
npm install
npx sideshow serve --open   # viewer on http://localhost:4242
```

Then point your agent at the surface:

```sh
curl -s http://localhost:4242/setup >> AGENTS.md
```

That block teaches any agent with a shell (pi, opencode, amp, codex, Claude
Code) to publish snippets and poll for comments over curl.

No agent handy? `npx sideshow demo` seeds two example sessions to look around.

## Connecting agents

Pick whichever tier the agent supports — each one covers the full loop.

**Shell.** The `sideshow` CLI has no dependencies and groups sessions for you:

```sh
sideshow publish sketch.html --title "Cache layout"
sideshow wait      # block until the user comments
```

**MCP.** Tools: `publish_snippet`, `update_snippet`, `wait_for_feedback`,
`reply_to_user`, `list_snippets`, `get_design_guide`. Connect over stdio or
straight to the server at `/mcp`:

```sh
claude mcp add --scope user sideshow -- npx -y sideshow mcp
# or, no local process:
claude mcp add --scope user --transport http sideshow http://localhost:4242/mcp
```

**Plain HTTP.** `POST /api/snippets`, `PUT /api/snippets/:id`, and
`GET /api/comments?wait=60` for long-polling. Documented at `/guide`.

MCP agents get usage instructions automatically; everything else uses the
`/setup` block above. Claude Code users can also install the skill in
`skills/sideshow/` (`cp -r skills/sideshow ~/.claude/skills/`).

### Claude Code plugin

Claude Code users can install a plugin that bundles all three at once — the
MCP server, the skill, and a **background monitor** that streams your browser
comments to the agent as notifications, so feedback arrives without pasting or
re-arming a watcher:

```text
/plugin marketplace add modem-dev/sideshow
/plugin install sideshow@sideshow
```

On install it asks for your **Sideshow URL** (default `http://localhost:4242`,
or your deployed instance) and an optional token. The monitor runs
`sideshow watch` against your board; comments are delivered to the agent
exactly once. Requires Claude Code ≥ 2.1.105. The viewer's "connect Claude
Code" link (sidebar footer) shows the same steps. The plugin lives in
[`plugin/`](plugin/).

## Concepts

- **Session** — one agent conversation. Sessions appear in the viewer sidebar;
  click a title to rename, hover to delete.
- **Snippet** — one published HTML fragment. It renders in a sandboxed iframe
  (`sandbox="allow-scripts"`, no same-origin) under a CSP that limits external
  resources to a short CDN allowlist. Updating a snippet creates a new version;
  old versions stay viewable.
- **Comment thread** — every snippet has one. You write in the browser; agents
  read via long-poll (`sideshow wait` or `wait_for_feedback`) and reply. A
  snippet can also call `sendPrompt('...')` to post to its own thread.

The design contract at `/guide` tells agents how to write snippets that fit the
viewer: fragment-only HTML, theme CSS variables, dark mode rules.

## Architecture

- `server/app.ts` — runtime-agnostic Hono app: REST API, SSE live feed,
  long-poll comments, snippet renderer, MCP endpoint.
- `server/storage.ts` — `Store` interface and the JSON-file implementation.
- `viewer/` — the viewer, a single static HTML file.
- `bin/sideshow.js` — CLI, Node built-ins only.
- `mcp/server.ts` — stdio MCP server, a thin client over the HTTP API.
- `workers/` — Cloudflare entry point and SQLite store.

## Deploying to Cloudflare

The same app runs on Cloudflare Workers — for when agents run on a different
machine than the browser, or you want the viewer on your phone.

```sh
npx wrangler login
npx wrangler secret put SIDESHOW_TOKEN   # any long random string
npm run deploy                           # https://sideshow.<account>.workers.dev
```

A deployed instance requires the token on every request. Open the viewer once
as `/?key=<token>` to set a cookie. Agents need two environment variables; the
CLI and stdio MCP pick them up automatically:

```sh
export SIDESHOW_URL=https://sideshow.<account>.workers.dev
export SIDESHOW_TOKEN=<token>
```

Remote agents can connect MCP straight to the deployment:

```sh
claude mcp add --transport http sideshow https://sideshow.<account>.workers.dev/mcp \
  --header "Authorization: Bearer $SIDESHOW_TOKEN"
```

The whole app runs inside a single Durable Object with SQLite storage. One
instance per board keeps the in-memory event bus authoritative, so SSE and
long-polling behave the same as the local server.

## Development

```sh
npm run dev          # server with watch + viewer watch build
npm test             # node --test
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint
npm run format       # oxfmt
```

The server and CLI have no build step — TypeScript runs directly on Node via
native type-stripping, and the npm package ships compiled JS built on prepack.
The viewer (`viewer/src/`, Solid) is the exception: Vite builds it into a
single self-contained `viewer/dist/index.html` (`npm run build:viewer`). See
[AGENTS.md](AGENTS.md) for architecture rules.

## License

[MIT](LICENSE)

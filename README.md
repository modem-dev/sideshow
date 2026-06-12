# sideshow

[![CI](https://github.com/modem-dev/sideshow/actions/workflows/ci.yml/badge.svg)](https://github.com/modem-dev/sideshow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A live visual surface for terminal coding agents.

Coding agents work in plain text, but a lot of what they have to say is
visual: an architecture diagram, a UI sketch, a chart. sideshow runs a small
server with a browser viewer. Agents publish HTML snippets to it from the
terminal, the snippets render live, and you can comment on them in the
browser. Comments are delivered back to the agent.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/sideshow-dark.png">
  <img alt="The sideshow viewer: agent sessions in a sidebar, a published JWT-flow diagram with a comment thread between the user and claude-code, and an interactive backoff explainer below" src="docs/sideshow-light.png">
</picture>

Above: an agent published a sequence diagram while working on an auth
refactor. The user asked a question under it, and the agent answered in the
thread and revised the snippet.

The loop in motion — publish, live appear, comment, revise:

![Animated demo: an agent publishes a diagram that appears live in the viewer, the user types a question under it, and the agent revises the snippet to a second version and replies in the thread](docs/sideshow-demo.gif)

## Quick start

Requires Node 22.18 or newer.

```sh
npm install
npx sideshow serve --open   # viewer on http://localhost:4242
```

Then tell your agent the surface exists:

```sh
curl -s http://localhost:4242/setup >> AGENTS.md
```

That block teaches any agent with a shell tool (pi, opencode, amp, codex,
Claude Code) how to publish snippets and poll for your comments using curl.

No agent handy? `npx sideshow demo` seeds two example sessions so you can
look around the viewer.

## Connecting agents

Use whichever the agent supports:

1. Shell. The `sideshow` CLI has no dependencies and handles session grouping
   itself:

   ```sh
   sideshow publish sketch.html --title "Cache layout"
   sideshow wait      # block until the user comments
   ```

2. MCP. Tools: `publish_snippet`, `update_snippet`, `wait_for_feedback`,
   `reply_to_user`, `list_snippets`, `get_design_guide`. Available over stdio
   or directly from the server at `/mcp`:

   ```sh
   claude mcp add --scope user sideshow -- npx -y sideshow mcp
   # or, no local process:
   claude mcp add --scope user --transport http sideshow http://localhost:4242/mcp
   ```

3. Plain HTTP. `POST /api/snippets`, `PUT /api/snippets/:id`, and
   `GET /api/comments?wait=60` for long-polling. Documented at `/guide`.

Agents that connect over MCP get usage instructions automatically. For
everything else there is the `/setup` block above, and Claude Code users can
optionally install the skill in `skills/sideshow/`
(`cp -r skills/sideshow ~/.claude/skills/`), which adds workflow guidance for
illustration requests.

## Concepts

A session is one agent conversation. Sessions appear in the viewer sidebar;
click a title to rename, hover to delete.

A snippet is one published HTML fragment. It renders in a sandboxed iframe
(`sandbox="allow-scripts"`, no same-origin) with a CSP that limits external
resources to a short CDN allowlist. Updating a snippet creates a new version,
and old versions stay viewable.

Each snippet has a comment thread. You write in the browser; agents read via
long-poll (`sideshow wait` or the `wait_for_feedback` tool) and can reply.
A snippet can also call `sendPrompt('...')` to post to its own thread.

The design contract at `/guide` tells agents how to write snippets that fit
the viewer: fragment-only HTML, theme CSS variables, dark mode rules.

## Architecture

- `server/app.ts` — runtime-agnostic Hono app: REST API, SSE live feed,
  long-poll comments, snippet renderer, MCP endpoint.
- `server/storage.ts` — `Store` interface and the JSON-file implementation.
- `viewer/` — the viewer, a single static HTML file.
- `bin/sideshow.js` — CLI, Node built-ins only.
- `mcp/server.ts` — stdio MCP server, a thin client over the HTTP API.
- `workers/` — Cloudflare entry point and SQLite store.

## Deploying to Cloudflare

The same app runs on Cloudflare Workers, which is useful when agents run on
machines other than the one with the browser, or when you want the viewer on
your phone.

```sh
npx wrangler login
npx wrangler secret put SIDESHOW_TOKEN   # any long random string
npm run deploy                           # https://sideshow.<account>.workers.dev
```

A deployed instance requires the token on every request. Open the viewer once
as `/?key=<token>` to set a cookie. Agents need two environment variables, and
the CLI and stdio MCP pick them up automatically:

```sh
export SIDESHOW_URL=https://sideshow.<account>.workers.dev
export SIDESHOW_TOKEN=<token>
```

Remote agents can also connect MCP straight to the deployment:

```sh
claude mcp add --transport http sideshow https://sideshow.<account>.workers.dev/mcp \
  --header "Authorization: Bearer $SIDESHOW_TOKEN"
```

Implementation: the whole app runs inside a single Durable Object with
SQLite storage. One instance per board keeps the in-memory event bus
authoritative, so SSE and long-polling behave the same as the local server.

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

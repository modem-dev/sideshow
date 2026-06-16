# sideshow — agent guide

Guidance for agents developing this repo. (The block that teaches agents to
_use_ a running sideshow lives in `guide/AGENT_SETUP.md`, served at `/setup`.)
`CLAUDE.md` symlinks here.

## What this is and why

A live visual surface for terminal coding agents: agents publish HTML
snippets over CLI/MCP/HTTP; the user watches them render in a browser and
comments back. The two-way loop — publish → live render → comment →
revise/reply — is the product. When in doubt, optimize for the loop.

Current product stances (deliberate choices, not accidents — revisit
consciously, not as a side effect):

- One board per person; one session per agent conversation. Accounts and
  multi-user are out of scope; auth is a single deploy token.
- Three integration tiers, most universal first: zero-dependency CLI, MCP
  (stdio and streamable HTTP at `/mcp`), raw HTTP. Features should work on
  all three — the CLI and curl tiers are why agents with only a shell can
  use this.
- Feedback is never silently lost: a user comment renders somewhere in the
  viewer (card thread or session thread) and reaches the agent (`userFeedback`
  piggybacked on writes, a blocking wait, or a background watch). Guard this
  hardest — both halves have regressed before.

## Map

- `server/app.ts` — runtime-agnostic Hono app: all routes, SSE `/api/events`,
  long-poll `/api/comments`, renderer `/s/:id`, and the shared flow functions
  both REST and MCP call.
- `server/types.ts` — data model + `Store` interface; no runtime imports. A
  surface is an ordered list of parts (`html` | `diff`); a snippet is sugar for
  a single html part. `firstHtml`/`htmlPart` bridge the legacy snippet shape.
- `server/storage.ts` — `JsonFileStore` (local Node). `workers/sqlStore.ts` —
  `SqlStore` (Durable Object SQLite). Both must pass `test/storeContract.ts`,
  and both migrate legacy `snippets`/`snippetId` data to surfaces on load.
- `server/surfacePage.ts` — sandboxed document for one html part: CSP allowlist
  and the postMessage bridge (resize, sendPrompt, openLink). Diff parts never
  reach here — the viewer renders them natively (they are data, not markup).
- `server/mcpHttp.ts` — stateless MCP at `/mcp`. `mcp/server.ts` — stdio MCP,
  a thin client over the HTTP API (passes response fields through untouched).
- `viewer/` — the viewer: Solid + TypeScript in `viewer/src/`, built by Vite
  (`vite.config.ts`) into a single self-contained `viewer/dist/index.html`
  (vite-plugin-singlefile) that the server still serves as one in-memory
  document — there are no static-asset routes.
- `bin/sideshow.js` — CLI, Node built-ins only; `bin/demoData.js` — seed
  content for `sideshow demo`.
- `workers/index.ts` — Cloudflare entry; one Durable Object runs the whole app.
- `skills/sideshow/` + `guide/` — teach agents to use a running sideshow.
- `scripts/record-demo.mjs` — regenerates the README gif.

## Architecture invariants

- `server/{app,events,mcpHttp,surfacePage,types}.ts` stay runtime-agnostic
  (no `node:` imports); `tsconfig.workers.json` typechecks them against
  workers types. Node wiring belongs in `server/index.ts` / `server/storage.ts`.
- Server/CLI TypeScript runs directly on Node ≥22.18 via type stripping:
  erasable syntax only (no enums, no parameter properties), `.ts` extensions
  in relative imports, no build step (`npm pack` compiles `dist/` for the
  published CLI). The viewer is the one exception: Solid JSX needs real
  compilation, so `viewer/src/` is Vite-built (`npm run build:viewer`).
- Snippet iframes are sandboxed without `allow-same-origin`. Never weaken
  this. WebKit quirk: in sandboxed iframes ResizeObserver's initial callback
  may not fire and `documentElement.scrollHeight` ratchets to viewport height
  — the bridge reports `body.scrollHeight` on `load` plus staggered timers.
  Don't "simplify" it back; e2e covers it on real WebKit.
- Feedback cursor: each session carries `agentSeq`, the highest comment seq
  already delivered to the agent. Piggyback collection and `author=user`
  waits advance it, and `author=user` session waits with no explicit `after`
  resume from it — clients keep no cursor of their own, so CLI, MCP, and
  piggyback share one stream. The viewer's unfiltered reads never touch it.
  Delivery is exactly-once by design, across channels.
- `SqlStore` schema changes need in-place migration — deployed Durable
  Objects can't be reset. Follow the `pragma_table_info` probe pattern in its
  constructor.
- The server reads `viewer/dist/index.html` and `guide/` files at boot —
  rebuild (`npm run build:viewer`) and restart to see viewer changes.
  `npm run dev` runs a Vite watch build alongside the server; the e2e suite
  builds the viewer itself (Playwright global setup).

## Validation

```sh
npm test             # unit/API + store contract (node --test)
npm run typecheck    # three tsc programs: node + workers + viewer
npm run lint         # oxlint, warnings are errors
npm run format:check # oxfmt
npm run test:e2e     # Playwright, chromium + webkit (separate CI job);
                     # builds the viewer first via e2e/globalSetup.ts
```

The first four must pass before committing; pre-commit formats staged files
(`npm run prepare` after a fresh clone).

Testing notes:

- `runStoreContract()` runs the same suite against both stores. SqlStore runs
  on a `node:sqlite` shim (`test/sqlStorageShim.ts`); the ambient `SqlStorage`
  types live in `test/workersSqlTypes.d.ts` because the real workers types
  conflict with `@types/node`.
- `JsonFileStore` returns live objects that later mutate — capture fields
  before update calls when asserting against them.
- The session thread and the update-notes card are also `.card`s: scope
  snippet-card e2e selectors with `.card:not(#sessionThread):not(#whatsNew)`.

## Conventions

- Conventional Commits: `type(scope): description`.
- `CHANGELOG.md` under `[Unreleased]` (`Added`/`Changed`/`Fixed`), user-visible
  changes only; append to existing subsections, don't duplicate them.
- Release: move unreleased entries into a new version section, bump
  `package.json`, commit `chore(release): X.Y.Z`, tag `vX.Y.Z`, create the
  GitHub release with that section as notes, then `npm publish` (manual —
  the maintainer runs it; requires 2FA).

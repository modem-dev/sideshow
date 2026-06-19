# sideshow — agent guide

Guidance for agents developing this repo. (The block that teaches agents to
_use_ a running sideshow lives in `guide/AGENT_SETUP.md`, served at `/setup`.)
`CLAUDE.md` symlinks here.

## What this is and why

A live visual surface for terminal coding agents: agents publish surfaces
(multi-part cards — html, markdown, diff, terminal, image, mermaid, issue-tree) over
CLI/MCP/HTTP; the user watches them render in a browser and comments back. The
two-way loop — publish → live render → comment → revise/reply — is the product.
When in doubt, optimize for the loop.

Current product stances (deliberate choices, not accidents — revisit
consciously, not as a side effect):

- One board per person; one session per agent conversation. Accounts and
  multi-user are out of scope; auth is a single deploy token.
- Three integration tiers, most universal first: zero-dependency CLI, MCP
  (stdio and streamable HTTP at `/mcp`), raw HTTP. Features should work on
  all three — the CLI and curl tiers are why agents with only a shell can
  use this.
- Feedback is never silently lost: a user comment renders in the viewer (the
  card's thread) and reaches the agent (`userFeedback` piggybacked on writes, a
  blocking wait, or a background watch). Guard this hardest — both halves have
  regressed before.

## Map

- `server/app.ts` — runtime-agnostic Hono app: all routes, SSE `/api/events`,
  long-poll `/api/comments`, renderer `/s/:id`, asset upload/serve
  (`/api/assets`, `/a/:id`), and the shared flow functions both REST and MCP call.
- `server/types.ts` — data model + `Store` interface; no runtime imports. A
  surface is an ordered list of parts (`html` | `markdown` | `diff` | `terminal`
  | `image` | `mermaid` | `issue-tree`); a snippet is sugar for a single html part.
  `htmlPart` bridges the legacy snippet shape. Assets (uploaded blobs)
  are a separate entity, referenced by `image` parts; `selectEvictions`
  is the reference-aware LRU policy.
- `server/public.ts` — the `sideshow/server` package export (`createApp`,
  `JsonFileStore`, types) for embedding the app in a Node process.
- `server/storage.ts` — `JsonFileStore` (local Node). `workers/sqlStore.ts` —
  `SqlStore` (Durable Object SQLite). Both must pass `test/storeContract.ts`,
  and both migrate legacy `snippets`/`snippetId` data to surfaces on load.
- `server/kits.ts` — opt-in style/behavior bundles for html parts (`issues`,
  `slides`). An html part lists kit ids in `kits`; `renderHtmlPage` injects each
  kit's CSS/JS into the sandbox after the base. Runtime-agnostic; allowlisted in
  `surfaceParts` and listed at `/api/kits`. Adding a kit is a registry entry +
  a guide bullet — no new part kind, no native-render surface.
- `server/surfacePage.ts` — sandboxed documents for surface markup. `renderHtmlPage`
  wraps an html part (CDN-allowlist CSP + the postMessage bridge: resize,
  sendPrompt, openLink) and injects any opted-in kits (`kits.ts`).
  `renderSandboxedPart` wraps markup the viewer rendered
  to a string (markdown/mermaid/diff/terminal) under a tighter CSP (no
  `connect-src`, no CDN) — see `viewer/src/SandboxedPart.tsx`. Image, trace, and
  issue-tree parts stay native because they have no HTML sink (the viewer renders
  them with text nodes / `<img>` / JSX). No agent markup is ever set as
  `innerHTML` in the trusted viewer origin.
- `server/themes.ts` — theme registry (github/gruvbox/one), runtime-agnostic so
  both server and viewer import it. One `Palette` per light/dark per theme; the
  viewer-chrome vars and the html-part `--color-*` tokens are both _derived_
  from it, so they can't drift. Persisted per board (`Store.getSetting`),
  switched at `/api/theme`.
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
- **Agent-authored content that becomes HTML MUST render inside a sandboxed
  iframe — never as `innerHTML` (or any HTML sink) in the trusted viewer
  origin.** This is the core isolation rule, and it's load-bearing: the viewer
  shares an origin with the board's authenticated API and the comment→agent
  channel, so any markup that executes there can read every surface, act as the
  user, and inject prompts back to the agent. The rule applies to every part
  kind, comments, and anything else agent-authored. The two safe ways to render
  it: (a) **build a STRING and hand it to a sandbox iframe** — `SandboxedPart`
  for viewer-rendered parts (markdown/mermaid/diff/terminal, comments) and
  `renderHtmlPage` at `/s/:id` for html parts; or (b) **keep it as data and
  render with Solid text nodes / element attributes**, which escape by
  construction (image, trace). String-building in the viewer is fine — a string
  is not a DOM sink; danger only starts when it reaches the DOM, which must
  happen at an opaque origin. When you add a part kind, pick (a) or (b); never a
  third way. The iframes are sandboxed without `allow-same-origin` (opaque
  origin) and `connect-src`-free for rich parts (no exfil even if contained
  script runs); never weaken this.
- WebKit quirk in sandboxed iframes: ResizeObserver's initial callback may not
  fire and `documentElement.scrollHeight` ratchets to viewport height — the
  bridge reports `body.scrollHeight` on `load` plus staggered timers. Don't
  "simplify" it back; e2e covers it on real WebKit. Watch the inverse too: the
  bridge sizes the frame from `body.scrollHeight`, so a `white-space: pre-wrap`
  on `body` makes the template's surrounding newlines render as blank lines and
  inflate the height — scope `pre-wrap` to a wrapper element (see `CMT_CSS`).
- Feedback cursor: each session carries `agentSeq`, the highest comment seq
  already delivered to the agent. Piggyback collection and `author=user`
  waits advance it, and `author=user` session waits with no explicit `after`
  resume from it — clients keep no cursor of their own, so CLI, MCP, and
  piggyback share one stream. The viewer's unfiltered reads never touch it.
  Delivery is exactly-once by design, across channels.
- `SqlStore` schema changes need in-place migration — deployed Durable
  Objects can't be reset. Follow the `pragma_table_info` probe pattern in its
  constructor.
- A theme switch must re-theme every layer or it looks broken. Server-side html
  parts are injected at `/s/:id` (so the viewer keys each iframe `src` on
  `activeTheme()` to reload them); `viewer/src/theme.ts` swaps the chrome
  `<style>`. `MarkdownPart`/`DiffPart`/`MermaidPart` read `activeTheme()`
  reactively and re-render their string (shiki + mermaid bake colors in), which
  rebuilds the `srcdoc` `SandboxedPart` wraps it in — so the iframe reloads with
  the new chrome vars (`viewerThemeCss`) injected. The terminal is intentionally
  theme-independent. Add presets to the registry, not per-component.
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
- The update-notes card is also a `.card`: scope snippet-card e2e selectors
  with `.card:not(#whatsNew)`.

## Conventions

- Conventional Commits: `type(scope): description`.
- Changesets drive release notes. For user-visible changes run
  `npm run changeset` and select `patch`/`minor`/`major`; for maintenance-only
  PRs run `npm run changeset -- --empty`. Do not edit `CHANGELOG.md` for normal
  PRs — `npm run release:version` updates it during release prep.
- Release: run `npm run release:version`, commit `chore(release): X.Y.Z`, tag
  `vX.Y.Z`, and push the tag. The release workflow verifies the tag matches
  `package.json`, publishes npm with provenance, and creates the GitHub release
  from that changelog section. See `docs/releasing.md`.

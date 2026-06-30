# sideshow — agent guide

Guidance for agents developing this repo. (The block that teaches agents to
_use_ a running sideshow lives in `guide/AGENT_SETUP.md`, served at `/setup`.)
`CLAUDE.md` symlinks here.

## What this is and why

A live visual surface for terminal coding agents: agents publish posts
(multi-surface cards — html, markdown, diff, terminal, image, mermaid, json, code) over
CLI/MCP/HTTP; the user watches them render in a browser and comments back. The
two-way loop — publish → live render → comment → revise/reply — is the product.
When in doubt, optimize for the loop.

Current product stances (deliberate choices, not accidents — revisit
consciously, not as a side effect):

- One workspace per person; one session per agent conversation. Accounts and
  multi-user are out of scope; auth is a single deploy token.
- Three integration tiers, most universal first: zero-dependency CLI, MCP
  (stdio and streamable HTTP at `/mcp`), raw HTTP. Features should work on
  all three — the CLI and curl tiers are why agents with only a shell can
  use this.
- Feedback is never silently lost: a user comment renders in the viewer (the
  card's thread) and reaches the agent (`userFeedback` piggybacked on writes, a
  blocking wait, or a background watch). Guard this hardest — both halves have
  regressed before.
- Trace exists in the codebase as an experimental path. Keep it out of the
  product-facing surface taxonomy and agent guidance unless the task is
  explicitly about deciding or finishing traces.

## Map

- `server/app.ts` — runtime-agnostic Hono app: all routes, SSE `/api/events`,
  long-poll `/api/comments`, renderer `/s/:id`, asset upload/serve
  (`/api/assets`, `/a/:id`), and the shared flow functions both REST and MCP call.
- `server/types.ts` — data model + `Store` interface; no runtime imports. A
  post is an ordered list of surfaces (`html` | `markdown` | `diff` | `terminal`
  | `image` | `mermaid` | `json` | `code`); a snippet is sugar for a single html surface.
  `htmlSurface` bridges the legacy snippet shape. Assets (uploaded blobs)
  are a separate entity, referenced by `image` surfaces and the experimental
  trace path; `selectEvictions` is the reference-aware LRU policy.
- `server/public.ts` — the `sideshow/server` package export (`createApp`,
  `SqlStore`, `createSqliteStorage`, `JsonFileStore`, types) for embedding the app.
- `server/sqlStore.ts` — `SqlStore`, the SQLite-backed `Store`. It takes a
  `SqlStorage` (the narrow SQL surface declared in `types.ts`, not the ambient
  Cloudflare global), so the SAME store runs on the Durable Object
  (`ctx.storage.sql`) and on Node via `server/sqliteStorage.ts`'s `node:sqlite`
  adapter — the local default, so dev mirrors the deploy. `server/storage.ts` —
  `JsonFileStore`, the legacy single-file store, still selectable with
  `SIDESHOW_STORE=json`. All must pass `test/storeContract.ts`, and all migrate
  legacy `snippets`/`snippetId` data to surfaces on load. On first SQLite boot
  `migrateJsonToSqlite` copies an existing JSON workspace in once (identity, history,
  and comment `seq` preserved via `JsonFileStore.exportBoard` →
  `SqlStore.importBoard`); it's idempotent and never imports into a non-empty db.
- `server/kits.ts` — opt-in style/behavior bundles for html surfaces (`issues`,
  `slides`). An html surface lists kit ids in `kits`; `renderHtmlPage` injects each
  kit's CSS/JS into the sandbox after the base. Runtime-agnostic; allowlisted in
  `server/postSurfaces.ts` and listed at `/api/kits`. Adding a kit is a registry entry +
  a guide bullet — no new surface kind, no native renderer.
- `server/richRender.ts` — server-side renderers for the rich kinds
  (`renderMarkdown`/`renderCode`/`renderDiff`/`renderTerminal` → `{body, css}`),
  runtime-agnostic so they run on the Worker DO too (shiki on the JS regex
  engine, @pierre/diffs SSR via `shiki-js`, markdown-it, ansi_up — no WASM/DOM).
  `/s/:id` calls these and wraps the result in `renderSandboxedPart`.
- `server/surfacePage.ts` — sandboxed documents for surface markup. `renderHtmlPage`
  wraps an html surface (CDN-allowlist CSP + the postMessage bridge: resize,
  sendPrompt, openLink) and injects any opted-in kits (`kits.ts`).
  `renderSandboxedPart` wraps a server-rendered rich body (markdown/code/diff/
  terminal — see `richRender.ts`) under a tighter CSP (no `connect-src`, no CDN).
  `renderMermaidPage` is the one exception: mermaid needs a DOM, so it can't be
  server-rendered — instead it emits a self-rendering doc that loads mermaid from
  the CDN allowlist (so it uses the html-surface CSP, which permits the CDN). Image
  and json surfaces stay native because they have no HTML sink; the experimental
  trace path follows the same data-only rule. Comments render as escaped Solid
  text nodes. No agent markup is ever set as `innerHTML` in the trusted viewer
  origin.
- `server/themes.ts` — theme registry (github/gruvbox/one), runtime-agnostic so
  both server and viewer import it. One `Palette` per light/dark per theme; the
  viewer-chrome vars and the html-surface `--color-*` tokens are both _derived_
  from it, so they can't drift. Persisted per workspace (`Store.getSetting`),
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
  (and any other server file imported by Workers: no `node:` imports);
  `tsconfig.workers.json` typechecks them. Node wiring belongs in `server/index.ts` / `server/storage.ts`.
- Server/CLI TypeScript runs directly on Node ≥22.18 via type stripping:
  erasable syntax only (no enums, no parameter properties), `.ts` extensions
  in relative imports, no build step (`npm pack` compiles `dist/` for the
  published CLI). The viewer is the one exception: Solid JSX needs real
  compilation, so `viewer/src/` is Vite-built (`npm run build:viewer`).
- **Agent-authored content that becomes HTML MUST render inside a sandboxed
  iframe — never as `innerHTML` (or any HTML sink) in the trusted viewer
  origin.** This is the core isolation rule, and it's load-bearing: the viewer
  shares an origin with the workspace's authenticated API and the comment→agent
  channel, so any markup that executes there can read every post, act as the
  user, and inject prompts back to the agent. The rule applies to every surface
  kind, comments, and anything else agent-authored. The two safe ways to render
  it: (a) **build a STRING and serve it from `/s/:id` under a `sandbox` CSP
  header** — `renderHtmlPage` for html surfaces, `renderSandboxedPart` for the
  server-rendered rich kinds (markdown/code/diff/terminal), and
  `renderMermaidPage` for the mermaid CDN doc; or (b) **keep it as data and
  render with Solid text nodes / element attributes**, which escape by
  construction (image, json, comments, and experimental trace data). String-building
  on the server is fine — a string is not a DOM sink; danger only starts when it
  reaches the DOM, which must happen at an opaque origin. When you add a surface
  kind, pick (a) or (b); never a third way. The iframes are sandboxed without
  `allow-same-origin` (opaque origin) and `connect-src`-free for rich surfaces (no
  exfil even if contained script runs); never weaken this. Treat anything agent-
  or user-produced as untrusted, whatever its kind or route. Content served from
  a workspace-origin URL must be sandboxed by the response itself (a `sandbox` CSP
  **header**), not just the embedding iframe — a top-level load bypasses the
  attribute (as `/s/:id` does).
- Untrusted content can reach the host only through narrow channels (the
  postMessage bridge, the write API). Gate each so contained content can't
  impersonate the user, exfiltrate, or exhaust the server; add any new channel
  the same way.
- Every surface that becomes HTML (html + the rich kinds) is rendered server-side
  and served from `/s/:id?part=N` by real URL under a `sandbox` CSP header —
  opaque origin, not srcdoc/blob (which a Chrome 149 field trial fails to lay
  out). There is no viewer→server render round-trip and no transient frame store;
  don't reintroduce one, and don't render rich markup inline in the trusted
  viewer. Versioned+themed `/s/:id` responses are immutable, so they carry a
  long-lived `Cache-Control` and a per-`(id,part,version,theme,mode)` in-memory
  render cache (single-instance DO; swap for KV/Cache API if multi-instance).
- WebKit quirk in sandboxed iframes: ResizeObserver's initial callback may not
  fire and `documentElement.scrollHeight` ratchets to viewport height — the
  bridge reports `body.scrollHeight` on `load` plus staggered timers. Don't
  "simplify" it back; e2e covers it on real WebKit. Watch the inverse too: the
  bridge sizes the frame from `body.scrollHeight`, so a `white-space: pre-wrap`
  on `body` makes a template's surrounding newlines render as blank lines and
  inflate the height — scope `pre-wrap` to a wrapper element.
- Feedback cursor: each session carries `agentSeq`, the highest comment seq
  already delivered to the agent. Piggyback collection and `author=user`
  waits advance it, and `author=user` session waits with no explicit `after`
  resume from it — clients keep no cursor of their own, so CLI, MCP, and
  piggyback share one stream. The viewer's unfiltered reads never touch it.
  Delivery is exactly-once by design, across channels.
- `SqlStore` schema changes need in-place migration — deployed Durable
  Objects can't be reset. Follow the `pragma_table_info` probe pattern in its
  constructor.
- A theme switch must re-theme every layer or it looks broken — the chrome, the
  server-rendered html surfaces (reloaded), and each sandboxed-iframe surface (whose
  colors are baked into its string, so it must re-render, not just restyle). The
  terminal is intentionally theme-independent. Add presets to the registry, not
  per-component.
- The server reads `viewer/dist/index.html` and `guide/` files at boot —
  rebuild (`npm run build:viewer`) and restart to see viewer changes.
  `npm run dev` runs a Vite watch build alongside the server; the e2e suite
  builds the viewer itself (Playwright global setup).
- The viewer is also an **embeddable engine**. `mountViewer(el, host)`
  (`viewer/src/embed.tsx`) renders it into a shadow root with its own runtime,
  reading base path / route / theme from an injected host (`viewer/src/host.ts`)
  instead of `window`/`location`. `main.tsx` is the default self-hosted host and
  renders into `document.body` unchanged — **self-hosted behaviour must stay
  identical** (the e2e suite is the parity oracle). So in `viewer/src`, don't
  reach for `document`/`location`/`history`/`:root` directly; go through
  `root()`/`host()` so both the self-hosted document and the embedded shadow
  root work (`:root` matches nothing in a shadow root, and there is no
  `<html>`/`<body>` — `:host` plays `<body>`'s role; see `embed.tsx`). Build the
  bundle with `npm run build:embed` (→ `viewer/dist-embed/engine.js`, the
  `sideshow/viewer-embed` export); it is folded into `npm run build`.
  Embed-host contract changes (`liveTransport`, `homeView`, `hideBrand`, slots,
  `onReady`, theme mirroring, etc.) need `viewer/embed.d.ts` and focused embed
  e2e coverage; self-hosted behavior must stay identical.

## Validation

```sh
npm test             # unit/API + store contract (node --test)
npm run typecheck    # three tsc programs: node + workers + viewer
npm run lint         # oxlint, warnings are errors
npm run format:check # oxfmt
npm run security:audit
npm run test:e2e     # Playwright, chromium + webkit (separate CI job);
                     # builds the viewer first via e2e/globalSetup.ts
```

The first five must pass before committing; e2e should pass before merge for
viewer/rendering changes. CI also gates PRs on changeset status and smoke-tests
the packed CLI. Pre-commit formats staged files (`npm run prepare` after a fresh clone).

Testing notes:

- `runStoreContract()` runs the same suite against every store. SqlStore runs
  on `createSqliteStorage()` (`:memory:`), the same `node:sqlite` adapter the
  local server uses on disk — so the contract covers the real Node SQLite path.
  `SqlStorage`/`SqlStorageValue`/`SqlStorageCursor` are plain interfaces in
  `server/types.ts`; a real DO `SqlStorage` is structurally assignable, so no
  ambient Cloudflare globals are needed in the node program. `test/migration.
test.ts` covers the JSON→SQLite import.
- `JsonFileStore` returns live objects that later mutate — capture fields
  before update calls when asserting against them.
- The update-notes card is also a `.card`: scope post-card e2e selectors
  with `.card:not(#whatsNew)`.

## Conventions

- **Naming (rename in progress).** A published artifact is a **post** (an ordered
  list of **surfaces**); a surface is one block (html/markdown/diff/image/…). In
  new code use these names — never `part`, never `surface` for the artifact. The
  data layer (`server/types.ts`, the stores), the wire (canonical `/api/posts`),
  MCP tools (canonical `publish_post`/`update_post`/`list_posts`), the viewer
  engine, the CLI help, and `guide/*.md` all use them now. Retired spellings stay
  as back-compat ONLY at the boundary: the legacy HTTP routes (`/api/surfaces`,
  `/api/snippets`), the `parts` request-body key, the `?part=` query key, the
  `/s/:id` route alias, and the deprecated MCP tool
  aliases (`publish_surface`, etc.) — keep these byte-identical. The tenant DB is
  a **workspace** (`board` is being retired). Canonical glossary: sideshow-cloud
  `docs/glossary.md`.
- Conventional Commits: `type(scope): description`.
- Changesets drive release notes. For user-visible changes run
  `npm run changeset` and select `patch`/`minor`/`major`; for maintenance-only
  PRs run `npm run changeset -- --empty`. Do not edit `CHANGELOG.md` for normal
  PRs — `npm run release:version` updates it during release prep.
- Release: run `npm run release:version`, commit `chore(release): X.Y.Z`, tag
  `vX.Y.Z`, and push the tag. The release workflow verifies the tag matches
  `package.json`, publishes npm with provenance, and creates the GitHub release
  from that changelog section. See `docs/releasing.md`.

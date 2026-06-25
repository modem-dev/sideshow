# Changelog

## 0.8.0

### Minor Changes

- f8fb7b3: Viewer: the sidebar wordmark is now a home link. Clicking "sideshow" (in the aside, or the mobile topbar) clears the current session and returns to the session-less base route — a guaranteed way back to the board from anywhere. It's a real `<button>`, so it's keyboard- and screen-reader-reachable. The new `goHome()` always asks the host to navigate (it never short-circuits on the engine's own selection), so an embedding host that layers its own view over the board — e.g. sideshow cloud's full-page Settings, which has no session rows to click out of on an empty board — gets a reliable exit through the same click; the host dedupes a no-op move. Self-hosted behaviour is otherwise unchanged.
- 4822f77: Embeddable engine: add `onReady?()` to the `SideshowHost` contract and stop flashing the empty-board onboarding before sessions load. On mount the board has no sessions yet, so it rendered `#onboard` (the "setup" pane) until `/api/sessions` resolved, then swapped to a session — a visible flash. The onboarding pane is now gated behind a first-load signal so neither pane is decided before that fetch returns, and the engine calls `host.onReady()` once it resolves and the board is decided. An embedder (e.g. sideshow cloud) holds its loading overlay until then so its users never see the pre-load flash; it fires even if the fetch failed (the board falls back to onboarding), so an overlay can't get stuck. Optional: the trivial self-hosted host omits it — self-hosted simply no longer flashes onboard.
- 760320f: Embeddable engine: add `onThemeChange?(tokens)` to the Host contract. The engine now PUSHES its fully-resolved palette to the host on initial mount, on every live theme switch, and on an OS light/dark flip — symmetric with `router.navigate`. An embedder (e.g. sideshow cloud) mirrors those tokens onto its own chrome instead of scraping computed styles across the shadow boundary. Optional: the trivial self-hosted host omits it, so self-hosted behaviour is unchanged.
- 38992d7: Embeddable engine: expose `layout` and `readonly` on the `SideshowHost` contract. A host can now request the stream-only layout (`layout: "stream"` — no sidebar/session list, just the current session's stream) and hide write affordances (`readonly: true`) without relying on the self-hosted `window.__SIDESHOW_*` globals. Self-hosted public-read "session" links keep mapping to the stream layout, so that flow is unchanged.
- 23be3a1: Link unfurl / inline preview support. Bare `/s/:id` URLs now serve the viewer shell with Open Graph and Twitter Card metadata, so pasting a surface link into Slack, Twitter/X, Discord, or iMessage renders an inline preview card. The `og:image` points to `/s/:id.png?card=1`, which captures a fixed 1200×630 social-card screenshot. Metadata uses only the surface title and a static description — no tokens or session context are leaked.
- 12bb6b4: Embeddable engine: add a `ss:main` host-overridable slot (`SLOTS.main`) wrapping the whole main content pane (onboarding + session stream). Its fallback is the engine's normal board, so a plain embed and self-hosted sideshow are unchanged. Unlike the always-on footer/empty/session-action overrides, this one is meant to be projected conditionally: an embedder (e.g. sideshow cloud) projects a `slot="ss:main"` child only while its own full-pane view is active — taking over the main area while the sidebar (session list, account footer) stays — and the engine falls back to the board when the child is gone.
- bd8df08: Screenshot surfaces as PNG by appending `.png` to any surface URL (e.g. `/s/:id.png`). Uses Cloudflare Browser Rendering to capture the rendered page. Supports `?mode=dark|light`, `?theme=`, `?w=` (width), and `?nocache` params. The viewer persists the user's OS color-scheme in a cookie so screenshots automatically match their light/dark preference.
- e924954: Rename the data model: the published artifact `Surface` → `Post`, and its blocks (`SurfacePart` and the `*Part` variants) → `Surface`. The block field `parts` → `surfaces`, and comment links `surfaceId`/`surfaceTitle` → `postId`/`postTitle`. Exported types, `Store` methods (`listSurfaces`→`listPosts`, …), and helpers (`htmlPart`→`htmlSurface`, `MAX_BOARD_ASSET_BYTES`→`MAX_WORKSPACE_ASSET_BYTES`, `BoardSnapshot`→`WorkspaceSnapshot`) are renamed to match — **a breaking change for library consumers importing these names.**

  SQLite boards migrate in place via a new idempotent `migrateToPosts()` (table `surfaces`→`posts`, column `parts`→`surfaces`, comment columns renamed, history blob re-keyed), mirroring the JSON store's read-time shims. Existing data is preserved.

  Wire: full-object reads `GET /api/surfaces/:id` and `GET`/`POST` `/api/comments` now emit the renamed fields (`surfaces`, `postId`/`postTitle`). Route paths and MCP tool names are unchanged in this release.

- eb2001d: Embeddable engine: add a `ss:session-actions` host-overridable slot (`SLOTS.sessionActions`) in the session header, beside the stream/timeline toggle. It is empty by default — self-hosted renders nothing there — so an embedder (e.g. sideshow cloud) can project session-scoped controls such as a "Share" button into the engine's own chrome without forking the viewer.
- 9da948d: The local Node server now stores data in SQLite (via the built-in `node:sqlite`)
  by default — the same `SqlStore` the Cloudflare Durable Object deploy runs, so
  local development mirrors production over one storage code path instead of a
  separate JSON file. On first SQLite boot an existing `sideshow.json` board is
  migrated in once automatically (sessions, surfaces, version history, comment
  ordering, and assets preserved); the JSON file is left untouched as a backup,
  and the import never runs again or overwrites a non-empty database.

  This also fixes the JSON store's scaling cliff — it rewrote the entire file
  (assets base64-inlined) on every write — since assets are now per-row BLOBs.

  Both stores now strip embedded NUL bytes from stored text (titles, comments,
  trace labels, settings) so they behave identically — SQLite would otherwise
  truncate a value at the first NUL while the JSON file preserved it.

  Configuration: `SIDESHOW_STORE=json` keeps the legacy single-file JSON store;
  `SIDESHOW_DB` sets the SQLite file path (default `data/sideshow.db`);
  `SIDESHOW_DATA` still names the JSON file and doubles as the migration source.
  The `sideshow/server` package now also exports `SqlStore` and
  `createSqliteStorage` alongside `JsonFileStore`.

- f5e89d7: Direct links to a surface open a full-page standalone view again. Visiting a bare `/s/:id` URL now shows just that one surface — its title and parts, no sidebar, session feed, or comment thread — with a small "made with sideshow" watermark beneath it, instead of resolving the link into its session's stream. The parts still render in the same sandboxed iframes the board uses (sized by the same resize bridge), and the link keeps its canonical `/s/:id` URL. Link-preview metadata from the bare route is unchanged.
- 5436598: Embeddable engine: publish the theme-token contract as data via a new lightweight `sideshow/theme-tokens` entry (also re-exported from `sideshow/viewer-embed`). It exports `THEME_TOKEN_NAMES` (the coarse subset of palette vars a host mirrors), the `ThemeTokens` type, and `THEME_DEFAULTS` (the default theme's built-in light/dark values, derived from the theme registry — never hand-copied). A host (e.g. sideshow cloud) can now consume the token names and no-flash fallback colors as typed data instead of copying hex by hand, so the two design systems can't silently drift. The `/theme-tokens` entry is engine-free and Node-safe, so build scripts can read it without pulling in the viewer runtime.

### Patch Changes

- b60c9a2: Cap the asset-upload body while streaming so a chunked request can't OOM the
  server. `POST /api/assets` rejected oversize uploads by their `Content-Length`
  header, then read the rest with `arrayBuffer()` — but a chunked upload sends no
  `Content-Length`, so the header check was skipped and the entire body was
  buffered into memory before any size check. On a board reachable beyond
  localhost (and the local default has no auth token), that's an unauthenticated
  out-of-memory vector. The body is now read through a capped reader that stops at
  the same limit, so an over-cap stream is refused with a 413 without being
  buffered first. The post-decode cap in `uploadAsset` is unchanged.
- eb269b5: Cap every request body so an oversize JSON or MCP payload can't OOM the server.
  The previous fix bounded `/api/assets`, but every other write endpoint
  (`/api/surfaces`, `/api/comments`, `/api/sessions`, the trace ingest, `/api/theme`)
  and `/mcp` still read their body with an unbounded `c.req.json()` — so the same
  unauthenticated out-of-memory vector was reachable by POSTing a giant JSON body
  instead (the local default has no auth token). A global `bodyLimit` now rejects
  any request body over a generous ceiling with a 413, short-circuiting on an
  oversize `Content-Length` and otherwise aborting the stream at the cap so a
  chunked body can't slip past. It runs after auth (unauthenticated requests on a
  token board are refused before their body is read) and exempts `/api/assets`,
  which streams its own stricter cap.
- ff217bf: The pi extension's tool schema now accepts the `mermaid` surface part kind. It was omitted from the extension's `kind` enum when mermaid landed, so a pi agent publishing `{kind:"mermaid", mermaid:"..."}` hit a validation error (`parts.0.kind: must be equal to one of the allowed values`) even though the server, MCP spec, and CLI already accepted it. The extension schema now mirrors `mcpSpec.ts`.
- c8f7c68: Tighten input validation at the edges:
  - Malformed base64 in an asset upload (REST `/api/assets` and the `upload_asset`
    MCP tool) now returns a clean 400 instead of surfacing a raw decode error as a 500.
  - Comment text and surface/session titles are capped (8 KB / 500 chars) before
    they ride the feedback channel back to the agent, so one oversize value can't
    bloat the agent's context on every poll.
  - The CLI's `--after` flag (`wait`, `watch`) now fails fast on a non-numeric
    value instead of silently ignoring it.

- c04a9ac: Mermaid diagrams now fully re-theme on a light/dark flip. The renderer drove mermaid's `base` theme from the design tokens but left mermaid to derive the rest, so colors it computes itself stayed stuck in light mode — most visibly arrowheads (derived from a hardcoded light canvas) kept their dark fill while the edges they cap flipped. The renderer now passes `darkMode` and `background` and pins the previously-derived arrow/text colors to the viewer's tokens, so every element tracks the active scheme.
- 58c515f: Validate the `openLink` scheme host-side so a surface can't ask the viewer to
  open a non-http(s) URL. The in-frame click handler only forwards `http(s)`
  hrefs, but a surface script can call `openLink()` directly — or post the bridge
  message raw — with any scheme (`javascript:`, `data:`, `file:`), and the host
  opened it after a confirm without re-checking. `noopener` already kept those
  from reaching the board, but the host now refuses anything that isn't
  `http(s)://` outright, matching the documented "external link" contract.
- 6e3c1b6: Refresh two README surface-gallery examples so each shows off what its part is for: the `html` example is now a shadcn/ui-style ecommerce products data table (filters, status badges, row selection, pagination) instead of a node-flow diagram, and the `image` example is a designed SaaS billboard ad instead of a before/after bar chart. Updates `scripts/surface-examples/*` and regenerates `docs/surfaces/{01-html,06-image}.png`; no runtime or API changes.
- 134a926: Reserve the `user` comment author so surface content can't impersonate the user
  to the agent. `author:"user"` was a forgeable label trusted as a security
  signal: a surface's script could call `sendPrompt()` (or post the raw bridge
  message) with no user interaction, and the result became an `author:"user"`
  comment indistinguishable from one the user typed — laundering untrusted content
  rendered in a surface into instructions delivered to the agent through the
  feedback loop. Now `user` is minted only by the viewer's composer (genuine
  keystrokes in the trusted origin): surface `sendPrompt` posts an `author:"surface"`
  thread message that is never delivered through the feedback channel, and the
  HTTP MCP `reply_to_user` tool coerces `author:"user"` to `"agent"` so the agent
  can't claim it either. The impersonation is now structurally impossible rather
  than gated.
- bd3ea88: Fix rich parts (markdown/code/diff/terminal) that intermittently rendered blank
  or clipped on reload under a Chrome 149 field trial, by rendering them
  server-side and serving each from `/s/:id?part=N` by real URL — the same
  opaque-origin, real-navigation load path html parts already use, which the field
  trial doesn't break (it defers layout only for in-memory `srcdoc`/`blob:`
  documents). Rich documents render with shiki, @pierre/diffs, markdown-it, and
  ansi_up on the server (no DOM/WASM, so they run on the Worker too) under a tight
  `sandbox` CSP response header with no `connect-src` and no CDN script source.
  Mermaid, which needs a DOM, instead emits a self-rendering document that loads
  mermaid from the CDN inside the sandbox. Versioned, themed `/s/:id` responses
  are immutable, so they now carry a long-lived `Cache-Control` and an in-memory
  render cache. Removes the viewer→server `POST /api/frames` → `/f/:id` round-trip
  and transient frame store the previous workaround added, and drops mermaid and
  shiki from the viewer bundle.
- 3752061: Sandbox the `/s/:id` surface document with a CSP response header, so agent
  script can never run in the board origin even on a top-level load. The viewer
  embeds surfaces in a `sandbox="allow-scripts"` iframe (opaque origin), but the
  document is served from the board's own origin — so opening `/s/:id` directly (a
  user choosing "open frame in new tab", an agent-shared link) ran the agent's
  script _in the board origin_, where it could reach same-origin storage or
  `window.open()` the real viewer. A `sandbox` directive can only be set as a
  response header (not the page's meta-tag CSP), and now forces the same
  opaque-origin sandbox however the document is loaded: `allow-scripts` so the
  bridge still runs, never `allow-same-origin`. Mirrors the iframe's own flags.
- 57829c0: Fix an auto-resize feedback loop that could pin a CPU core. A sandboxed surface reports its content height to the host, which sizes the iframe to match; when the content's height inverts with the frame height (a scrollbar that toggles at a threshold, a 100vh/percentage layout), sizing the frame changes the content height back, so reports alternate A, B, A, B… once per frame. The old `h !== lastH` guard couldn't catch a 2-cycle, and on a heavy syntax-highlighted surface each relayout was expensive enough to sit at 100% CPU until the surface unmounted. The height reporter now remembers the previous height and drops a rapid return to it (< 250ms), breaking the loop while still honoring genuine changes (a `<details>` toggle, a textarea drag) that recur on a human timescale.
- 7f86b13: Harden share-link secrecy: session and surface ids are now 11 url-safe base64
  characters — 8 random bytes, ~64 bits, YouTube-video-id sized — instead of a
  UUID's first 32-bit segment. In `publicRead` mode these ids double as bearer
  capabilities (`/s/:id` and `/api/{sessions,surfaces}/:id` are reachable without
  the board token), so a 32-bit id (~4e9) was enumerable; 64 bits (~1.8e19) is
  far past sweepable. Existing ids keep working — nothing validates id shape — so
  only newly minted ones change. (Asset ids are a separate content hash and were
  already unguessable.)

## 0.7.0

### Minor Changes

- ee75c8d: Add an embeddable viewer engine. `mountViewer(el, host)` (the new
  `sideshow/viewer-embed` export) renders the viewer into a shadow root with its
  own runtime, reading its base path, route, and theme from an injected host
  instead of `window`/`location` — so a host application can own the page shell
  and URL while embedding the viewer. The self-hosted page is unchanged: it now
  uses a trivial default History-API host and behaves identically.
- a4033cf: Add host-overridable slots to the embeddable viewer engine. Two layout regions
  that carry deployment-specific guidance — the empty-board onboarding and the
  sidebar footer's instructional links — are now wrapped in named `<slot>`s whose
  fallback content is the existing self-hosted markup. An embedder projects
  light-DOM children with a matching `slot=` attribute into the mount element to
  replace a whole region; with nothing projected (and self-hosted, outside a
  shadow root) the fallback renders unchanged, so self-hosted parity is preserved.
  The new `SLOTS` registry and `SlotName` type are exported from the embed entry
  and `embed.d.ts` so embedders share one typed source of truth.
- 91db9a3: Add hosted wrapper seams, including injectable public base-path support for deployments mounted below an origin root while preserving default self-hosted routes.
- 3f45e76: Add `json` and `code` part kinds for surfaces.
  - **`json`** — a pre-parsed JSON value rendered natively by the trusted viewer
    as a collapsible tree. Objects and arrays expand/collapse on click; primitives
    show inline with type-colored values (strings, numbers, booleans, null). Reach
    for it for API responses, config files, test results — any structured data
    where a tree beats a fenced code block. Like image/trace it is data, not
    markup: the viewer renders it with escaped text nodes, so no sandbox is needed.

  - **`code`** — source code highlighted with shiki (the same highlighter as
    markdown fenced code blocks), rendered in a sandboxed iframe with line
    numbers, an optional filename header, and a copy button. `language` is a
    shiki lang id; `title` is a filename shown in the header; `lineStart` shows
    original line numbers for excerpts ("lines 80-150 of x.ts"). CLI:
    `sideshow code app.ts --title "app.ts" --line-start 80`.

  Also extracts the shared shiki highlighter into `viewer/src/highlight.ts` so
  MarkdownPart and CodePart share one lazy-loaded highlighter.

- ddbfab2: Add `SIDESHOW_PUBLIC_READ` env var for public read-only access to deployed boards. Set to `session` for unlisted-link style sharing or `full` to expose the entire board read-only.

### Patch Changes

- 5e3f292: Fix invisible markdown/mermaid/diff/terminal surfaces caused by a Chrome field trial that breaks layout measurement in opaque-origin srcdoc iframes. The viewer now retries the srcdoc parse after 2 seconds if the iframe is still stuck at minimum height.
- c2e4443: fix(viewer): honor `lineStart` in code-part gutter numbers. The code part's range label already reflected `lineStart`, but the gutter still counted from 1 — shiki emits `<pre class="shiki …" style="…">`, which the counter-reset injection didn't match. The starting line number now applies, so excerpts render at their original line numbers.
- 3c56cc1: Deep links to `/session/:id/s/:surfaceId` now scroll to the target surface card instead of showing the session from the top.
- 84e7057: Reject oversize asset uploads before buffering the body into memory. The /api/assets handler previously read the entire request body before checking the 5 MB cap, so a multi-GB upload could exhaust Node's heap on `sideshow serve` before the 413 fired.
- 6962019: Fix cursor lag in `waitForComments`. The `lastSeq` returned to the caller and the `agentSeq` cursor were both derived from the filtered (author-matched) comment list, not the full list. When an agent reply landed after the last user comment, the cursor stayed behind the agent's seq, so every subsequent `author=user` call re-read the agent's own comment, filtered it out, and advanced in a wasted round-trip. Both `lastSeq` and `markAgentSeen` now use the last seq from the unfiltered list, mirroring `collectFeedback`.
- a18f210: Fix surface iframes rendering in the wrong color scheme when it diverges from
  the chrome (e.g. dark chrome with a white, light-inked html part). Light/dark
  was resolved independently in every layer purely from the OS
  `prefers-color-scheme`, but a surface part is a separate iframe document whose
  scheme resolution can diverge from its embedder across the frame boundary. The
  viewer now resolves the scheme once and pins each sandboxed frame to it — html
  parts via a `mode` query param on `/s/:id` (with a forced `color-scheme`), and
  markdown/code/comment frames via `renderSandboxedPart` — so a frame always
  matches the chrome instead of re-deriving the scheme on its own. The theme
  tokens, the kit's teal/coral SVG accents, and shiki's dark flip are all pinned
  together. With no mode passed the OS media query is kept, so self-hosted parity
  is preserved.
- f0c6cd4: Fix a lost-update race in `SqlStore.updateSurface`. Two concurrent `PUT /api/surfaces/:id` calls could both read the same version, push a duplicate history entry, and write the same version number — silently losing one caller's parts. The fix uses compare-and-set (`WHERE id=? AND version=?`) with `SELECT changes()` to detect whether the update landed, retrying with the current version if it lost the race.
- db463ce: Improve intro readme.

## 0.6.0

Sideshow 0.6 focuses on richer surfaces, safer rendering, and better agent setup.

### Highlights

- **Timeline traces.** Sessions can show the prompts, reasoning, and commands behind a surface. Claude Code users can install the Stop hook with `sideshow install-hook`, or run `sideshow trace-sync` manually.
- **Themes.** The board now has seven light/dark theme presets — GitHub, Gruvbox, One, Solarized, Catppuccin, Rosé Pine, and Everforest — applied across viewer chrome, html tokens, markdown/diff highlighting, mermaid, and terminal parts.
- **Mermaid parts.** Agents can publish Mermaid diagrams directly with `sideshow mermaid`, `--mermaid`, MCP, or HTTP.
- **HTML kits.** Opt-in `issues` and `slides` kits give agents ready-made, theme-aware building blocks for issue trees, status boards, and decks. Discover them with `sideshow kits` or `GET /api/kits`.
- **Deep links.** Viewer URLs now track the current session and surface (`/session/:id`, `/session/:id/s/:surfaceId`), including back/forward navigation.
- **Pi extension.** Installing the package in Pi adds native `sideshow_*` tools for publishing, updating, uploading assets, waiting for feedback, replying, listing surfaces, and fetching the guide.

### Agent and viewer polish

- Added `/agent-howto` and `sideshow agent-howto`; the bundled skill/setup block is now a small bootstrap that asks the running server for current Sideshow guidance.
- Changed the default local server from `http://localhost:4242` to `http://localhost:8228`.
- Sidebar sessions now show agent logos, a surface count, and cleaner metadata.
- The card comment footer is flatter and quieter.
- Comments now always attach to a surface; `sideshow comment` requires `--surface`.
- The agent design guide is shorter and frames kits/theme tokens as optional scaffolding, not a required house style.

### Safety and reliability

- Markdown, Mermaid, diff, terminal parts, and comment text now render inside opaque-origin sandboxed iframes, matching html parts and reducing the impact of sanitizer regressions.
- The viewer only accepts host-affecting `postMessage` events from frames it embedded.
- Added focused unit and e2e coverage for sandbox isolation, themes, kits, trace ingest, and cross-channel feedback delivery.

## [0.5.0] - 2026-06-17

### Added

- Surfaces: a published card is now an ordered list of parts, not a single HTML
  blob. New part kinds render natively in the viewer alongside sandboxed `html`:
  `diff` (a syntax-highlighted code review from a patch), `markdown` (prose with
  highlighted fenced code), `terminal` (monospace output with ANSI colors), plus
  `image` and `trace`. Publish any of them across all three tiers — MCP
  (`publish_surface`/`update_surface`), `POST /api/surfaces`, and the CLI.
- Uploads: push images, traces, and files across all three tiers (`POST
/api/assets`, the `upload_asset` MCP tool, `sideshow upload`/`image`/`trace`).
  Assets are content-addressed by SHA-256, identical uploads dedupe, and an
  asset lives as long as any surface references it. Capped at 5 MB each.
- A Claude Code plugin (`plugin/`, via a repo-hosted marketplace) bundles the
  MCP server, the skill, and a background monitor — browser comments arrive in
  the agent as notifications without pasting or re-arming a watcher. Install with
  `/plugin marketplace add modem-dev/sideshow` then
  `/plugin install sideshow@sideshow`.
- `sideshow watch` streams user comments to stdout, re-arming the long-poll
  forever (exactly-once across watch, wait, and piggyback).
- A "connect Claude Code" link in the viewer opens an integrations panel with
  the plugin install commands and caveats.
- A copy button on each comment puts an agent-ready paste block (surface title +
  id + comment) on the clipboard.
- The npm package exposes a stable `sideshow/server` entrypoint so integrations
  can reuse `createApp`/`JsonFileStore` without importing private internals.

### Changed

- Snippets are now "surfaces" throughout the API (`/api/surfaces`, `surface-*`
  SSE events, comments keyed by `surfaceId`). The old snippet endpoints and
  `publish_snippet`/`update_snippet` tools remain as back-compat aliases; stored
  boards migrate in place on load.
- The session sidebar groups sessions by recency (Today / Yesterday / Earlier),
  and sessions with no surfaces yet are dimmed and sunk to the bottom.
- The viewer is framed around leaving comments rather than messaging an agent —
  composers read "Leave a comment…", with no delivery receipts or "listening"
  indicators.
- A surface card's open and delete actions are now minimal Lucide icons.
- `sideshow-term` auto-starts a local server when needed (bare `sideshow-term`
  opens the watcher, default port 4243), supports mouse input, and gains
  `clear` / `clear --all`.

### Fixed

- `sideshow-term` hardens STML parsing/rendering for untrusted markup (tested
  entity decoding, bounded size/depth, neutralized control characters, render
  failures degrade to an in-view error).
- Local JSON storage shares a single cold-load promise across concurrent first
  requests, fixing a race that could overwrite persisted board data.
- The viewer shows a neutral "refresh sideshow to update the viewer" hint for an
  unrecognized part kind instead of a broken-diff error.
- Malformed `POST`/`PUT /api/surfaces` part payloads are rejected before they
  reach storage.
- `sideshow-term` can be packaged and installed standalone (declared server
  dependencies, reuses the `sideshow` server core, runs built JavaScript).

## [0.4.0] - 2026-06-15

### Added

- Cmd+Option+Up/Down switches between sessions in the viewer without reaching
  for the sidebar — Down moves to the next session in the list, Up the
  previous, wrapping at the ends.
- The viewer notices new releases: a dismissable banner in the sidebar names
  the latest version with a copyable upgrade command (npm install locally,
  redeploy for workers), and the release notes render as a card at the top of
  the stream. Dismissing either hides both until the next release. The check
  lives server-side at `/api/version` (npm registry + GitHub release notes),
  is cached for six hours, and fails silently — offline costs nothing but the
  absence of the notice.
- The CLI now runs on Windows: session detection walks the process tree with a
  single PowerShell call instead of `ps`, and `sideshow serve --open` launches
  the browser via `cmd /c start`. macOS and Linux are unchanged.

## [0.3.0] - 2026-06-12

### Added

- A session thread at the bottom of each session in the viewer: a composer
  for messaging the agent without picking a snippet.
- Feedback now reaches agents without polling: publish/update/reply responses
  carry a `userFeedback` array with any comments the user left since the
  agent's last call (delivered once; a consumed `wait` also counts as seen).
- The design guide, setup block, and Claude Code skill teach the background
  watch pattern: arm `sideshow wait` as a background process after publishing
  and react when it exits, instead of blocking or polling.
- Agents can name their session at creation: `sessionTitle` on the publish
  body and both MCP `publish_snippet` tools, `--session-title` on
  `sideshow publish`. Applied only when the publish creates the session —
  it never overwrites a title, including renames made in the viewer.
- A snippet kit baked into every snippet doc, so agents publish compact
  markup instead of hand-written inline CSS: bare `button`/`input`/`select`/
  `textarea` pre-styled to match the viewer, SVG utility classes (`t`/`ts`/
  `th` text presets, `box`, `arr`, `leader`, `node`, `c-*` color ramps with
  dark-mode-aware text), and a shared `#arrow` marker injected into every
  doc. The design guide documents it as a compact reference table.

### Changed

- New snippets no longer steal the scroll position: the viewer only follows
  them when already at the bottom of the stream, and shows a "new snippet ↓"
  pill otherwise.
- Activity the user isn't looking at — another session, or any session while
  the tab is hidden — badges the tab title with an unread count.
- The Claude Code skill now documents the repo-local CLI fallback and a
  checkpoint-drain feedback pattern for harnesses that cannot surface
  background watcher output.

### Fixed

- Feedback was re-delivered when channels were mixed: a fresh `sideshow wait`
  process (or restarted stdio MCP server) started from seq 0 and replayed
  comments the agent had already received via piggyback or another channel.
  `author=user` session reads with no explicit `after` now resume from the
  server-side agent cursor, and the CLI and stdio MCP keep no cursor of their
  own — delivery is exactly-once across CLI, MCP, and piggyback. Pass
  `--after <seq>` (CLI) or `afterSeq` (MCP at `/mcp`) to deliberately re-read.
- A comment that failed to send was silently lost (input cleared, no error).
  The viewer now echoes comments immediately (pending until confirmed) and on
  failure restores the text to the input with an error toast.
- After an SSE reconnect the viewer refetches the selected session, so
  snippets and comments that arrived during the gap can no longer be
  silently missing from a live-looking board.
- The viewer layout no longer breaks at phone widths: below 700px the
  sidebar collapses into a drawer behind a slim top bar (hamburger toggle,
  unread dot), the stream takes the full width, and hover-only actions
  (card open/delete, session delete) stay visible on narrow or touch
  screens.
- Comments not attached to a snippet (e.g. `sideshow comment` without
  `--snippet`) were stored and delivered to agents but never shown in the
  viewer; they now render in the session thread.
- The viewer is now usable by keyboard and assistive tech: session rows are
  focusable and activate with Enter/Space (focus survives live re-renders),
  hover-only actions (session delete, card open/delete) are reachable and
  shown on focus, the editable session title is labeled and Escape cancels
  an edit, snippet iframes carry the snippet title, and toasts are announced
  via a polite live region.
- `--help`/`-h` on CLI subcommands (`sideshow publish --help`, …) printed a
  raw parseArgs stack trace; it now prints the usage text and exits 0. An
  unknown option or missing option value likewise fails with a one-line
  error and a `sideshow help` hint instead of a stack trace.
- Following the README quick start from a git clone failed: `npx sideshow
serve` exited with `viewer build missing` because nothing built the viewer.
  `npm install` in the repo now builds it (the published npm package was
  unaffected — `prepack` already ships a built viewer).

## [0.2.0] - 2026-06-11

### Added

- `sideshow demo` seeds two example sessions (a sequence diagram with a
  comment thread, an interactive explainer, a metrics card) so the viewer can
  be explored without an agent.

## [0.1.0] - 2026-06-11

First release.

### Added

- Initial release: live preview surface (Hono server + single-file viewer)
  with sessions, versioned snippets, and comment threads.
- Zero-dependency `sideshow` CLI: `serve`, `publish`, `update`, `wait`,
  `comment`, `list`, `sessions`, `guide`, `setup`. Sessions resolve
  automatically per agent conversation.
- Stdio MCP server with `publish_snippet`, `update_snippet`,
  `wait_for_feedback`, `reply_to_user`, `list_snippets`, `get_design_guide`.
- Long-poll feedback endpoint (`GET /api/comments?wait=N`) so terminal agents
  can block on user comments without extra infrastructure.
- Agent design contract served at `/guide`; paste-able AGENTS.md integration
  block at `/setup`.
- Sandboxed snippet rendering (`sandbox="allow-scripts"`, CSP CDN allowlist)
  with light/dark theme CSS variables and a `sendPrompt`/`openLink` bridge.
- Cloudflare Workers deployment (`npm run deploy`): the whole app runs in a
  Durable Object with SQLite storage; local and cloud are the same product
  behind `SIDESHOW_URL` + `SIDESHOW_TOKEN`.
- Built-in MCP over streamable HTTP at `/mcp` on every server (local and
  deployed) — agents can connect without any local process.
- Token auth for deployed instances: bearer header for APIs, `/?key=<token>`
  cookie flow for the viewer; `/guide` and `/setup` stay public.
- Claude Code skill at `skills/sideshow/` teaching agents the publish →
  feedback → iterate workflow.

# Changelog

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

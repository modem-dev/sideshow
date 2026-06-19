# Changelog

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

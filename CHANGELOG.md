# Changelog

All notable user-visible changes to this project are documented in this file.

## [Unreleased]

### Added

- `markdown` parts: agents can publish prose (explanations, plans, tradeoff
  write-ups) the viewer renders with consistent typography — headings, lists,
  tables, links, and syntax-highlighted fenced code blocks (shiki, the same
  highlighter the diff parts use). Available on all three tiers: a `markdown` part
  over MCP and `POST /api/surfaces`, plus the CLI (`sideshow markdown`, and
  `--md` on `sideshow publish`). Rendered as data, not sandboxed markup: raw
  HTML in the source is escaped, so reach for an `html` part for live markup.
- The npm package now exposes a stable `sideshow/server` entrypoint for
  integrations such as `sideshow-term` to reuse `createApp` and `JsonFileStore`
  without importing private `dist/server/*` internals.
- Surfaces: a published card is now an ordered list of parts, not a single
  HTML blob. A `diff` part renders a unified/git patch as a syntax-highlighted
  split/unified code review (via @pierre/diffs) directly in the viewer; an
  `html` part is the sandboxed markup snippets always were. Combine them — e.g.
  a diagram html part above its diff — in one versioned, commentable card.
- Generic publishing across all tiers: `publish_surface`/`update_surface` (MCP),
  `POST /api/surfaces`, and `sideshow diff <patch>` / `sideshow publish --diff`.
  Diff parts are rendered from patch data by the viewer, so agents send a patch,
  never markup, and the sandbox is untouched.
- Uploads: agents can push images, traces, and files across all three tiers —
  `POST /api/assets` (raw bytes or base64 JSON), the `upload_asset` MCP tool, and
  `sideshow upload` / `image` / `trace` / `publish --image`. Reference an upload
  with an `image` part (rendered natively) or a `trace` part (a step timeline
  beside the surface, plus a download link), or embed its URL inside an html part
  (`<img src="/a/<id>">` — the surface CSP now allows the server's own origin).
  An asset's id is the SHA-256 of its bytes, so its URL is content-addressed:
  derive it before uploading (`sideshow asset-url <file>`) and reference it in a
  surface published before — or alongside — the upload; the viewer briefly waits
  for an in-flight asset instead of showing a broken image. Identical uploads
  dedupe to one blob, and an asset lives as long as any surface references it
  (even across sessions), so a referenced upload is never lost to a session
  delete. Capped at 5 MB each.

### Changed

- A surface card's open and delete actions are now minimal Lucide icons
  (external-link and trash) instead of text labels; delete turns red on hover.
- `sideshow-term watch` now starts a local server in the background when needed,
  and bare `sideshow-term` opens the watcher. Terminal servers default to port
  4243, with `--port` for choosing another local port. The watcher supports
  mouse input for clicking sidebar snippets and wheel-scrolling content.
  Agents can run `sideshow-term clear` to remove stale visualizations from the
  current session, or `sideshow-term clear --all` to clear the whole surface.
  `sideshow-term serve` remains for explicit server-only use.
- Snippets are now "surfaces" throughout the API: `/api/surfaces`, `surface-*`
  SSE events, and comments keyed by `surfaceId`. The old snippet endpoints and
  the `publish_snippet`/`update_snippet` tools remain as back-compat aliases, so
  existing agent configs keep working. Stored boards migrate in place on load.

### Fixed

- Local JSON storage now shares a single cold-load promise across concurrent
  first requests, preventing a race that could overwrite persisted board data.
- The viewer no longer renders a part whose kind it doesn't recognize as a
  broken diff ("Couldn't render diff — No diff content"). An unknown kind —
  what a long-open browser tab sees after a new part type ships — now shows a
  neutral "refresh sideshow to update the viewer" hint, and `diff` is dispatched
  explicitly rather than as the catch-all.
- Malformed `POST`/`PUT /api/surfaces` part payloads are now rejected before
  they reach storage, instead of being saved and failing later in the viewer.
- `sideshow-term` can now be packaged and installed standalone: its server
  runtime dependencies are declared, it reuses the `sideshow` package's server
  core, and published installs run built JavaScript instead of TypeScript from
  `node_modules`.

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

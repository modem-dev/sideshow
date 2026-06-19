# Plan: Claude Code plugin for sideshow (background-monitor feedback)

Status as of 2026-06-14. Written so it's useful cold (after a context compaction).

## Goal

Let a sideshow user's browser comments reach a Claude Code agent **automatically**,
without the user pasting a copy block or the agent re-arming a background `sideshow
wait` every turn. Do it with a **Claude Code plugin** that ships an always-on
**background monitor** running a continuous long-poll of the sideshow server.

Originating idea from the user: an "integrations" page in sideshow with a one-click
"install Claude plugin" button. See the "one-click reality" caveat below — there is no
true one-click, so that page becomes a copy-the-command card.

## Where things stand right now (context for after a compact)

- **Branch:** `feat/comment-and-copy` → PR **#16** (open) on `modem-dev/sideshow`
  (repo moved from `benvinegar/sideshow`; `origin` already points at modem-dev).
- **What PR #16 actually ships (net vs main, +96/-7, 4 files):** the viewer reframed
  around _leaving comments_ (composer placeholder "Leave a comment…", button "Comment")
  - a per-comment hover-only **copy** button (⧉) that copies an agent-ready paste block
    (`sideshow comment on "<title>" (snippet <id>): "<text>"`). Files: `viewer/src/Card.tsx`,
    `viewer/src/styles.css`, `e2e/viewer.spec.ts`, `CHANGELOG.md`. **The server is untouched
    in the net diff.**
- **History note:** mid-branch we built a "● listening" indicator + green read-receipt
  checkmarks (server-side wait tracking, `session-listening` event, `agentListening` on
  session rows, cursor-advance broadcasts), then **removed all of it** in the final commit
  when the user chose to reframe to "leave a comment" (async annotation model, no
  synchronous delivery UI). So those commits add-then-remove and net to zero on the server.
- **PR #16 TODO before merge:** the title is stale — still says "make the feedback loop
  legible — listening indicator, read receipts, per-comment copy". Retitle to reflect the
  reframe + copy button. Optionally squash the 5 exploration commits.
- **Local dev server:** `node bin/sideshow.js serve` on :8228, data at `data/sideshow.json`.
  Has accumulated demo snippets across sessions (`b903e7b7` "Sideshow test drive", plus a
  fresh session `f9d8b335` holding the summary + plan visualizations). Offer to delete demo
  cards when convenient.
- **Visualizations of this plan are on the board** (session `f9d8b335`): snippet
  `ed99a3aa` "How the Claude Code plugin would work" (the loop diagram) and `9020c512`
  "Build plan: three pieces + the one-click reality".

## How it works (architecture)

A clockwise loop:

1. Agent **publishes** a snippet via MCP → sideshow server.
2. Server renders it in the user's browser.
3. User **leaves a comment** in the browser → server.
4. **Monitor** (`sideshow watch`, always-on) long-polls the server and pulls each new
   user comment.
5. Each comment is printed as **one stdout line → one Claude Code notification**,
   delivered on the agent's next turn.

The monitor is essentially `sideshow wait` in a loop. Because it reads with
`author=user`, it rides the **same `agentSeq` cursor** that piggyback + `wait` already
share, so delivery stays exactly-once across channels (the invariant CLAUDE.md guards
hardest). Install once → comments arrive on their own.

## Verified Claude Code mechanics (from official docs, code.claude.com)

Confirmed via the claude-code-guide agent against current docs. Re-verify before building;
monitors are an `experimental.monitors` feature and may shift.

### Background monitors — `monitors/monitors.json` (Claude Code >= v2.1.105)

- Fields: `name` (req), `command` (req, shell command run as a persistent bg process in the
  session working dir), `description` (req), `when` (opt: `"always"` default, or
  `"on-skill-invoke:<skill>"`).
- Command supports `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`,
  `${user_config.*}`, `${ENV_VAR}`.
- **Each stdout line → one notification to Claude**, delivered on the next turn (no batching
  / no documented rate limit). Runs for the session lifetime; stops when the session ends;
  disabling the plugin mid-session does NOT stop an already-running monitor.
- Unsandboxed, same trust level as hooks. **No per-run approval** once installed; consent is
  at install time (project-scope requires workspace trust first).
- Docs: https://code.claude.com/docs/en/plugins-reference.md#monitors

### Plugin packaging

- One plugin can bundle a **monitor + MCP server + skill**. Manifest `.claude-plugin/plugin.json`
  with `experimental.monitors`, `mcpServers`, `skills` path fields.
- Layout: `monitors/monitors.json`, `.mcp.json`, `skills/<name>/SKILL.md`, `bin/...`,
  `.claude-plugin/plugin.json`.
- Docs: https://code.claude.com/docs/en/plugins-reference.md

### Installation contract

- Install methods: `/plugin install <name>@<marketplace>`, `claude plugin install ...`,
  `/plugin marketplace add <src>` then install, repo `.claude/settings.json` (team, prompts
  on workspace trust), `--plugin-dir ./path` (dev, session-scoped), `--plugin-url <zip>`.
- `marketplace.json` plugin sources: `github` (`owner/repo`), `url` (git URL), `git-subdir`,
  `npm`, relative paths (git-hosted marketplaces only).
- **A plain HTTP server CAN host a static `marketplace.json`** (`/plugin marketplace add
https://host/marketplace.json`) BUT relative plugin sources won't work there — the plugin
  itself must be `github`/`url`/`npm`. So serving the marketplace from the running sideshow
  server adds little for v1.
- **No browser→CLI handoff exists** — no `claude://` deep link / protocol handler. "One-click"
  is realistically **copy-to-clipboard of the install command**.
- Local-path install works: `/plugin marketplace add ./path` or `~/.claude/...`.
- Docs: https://code.claude.com/docs/en/discover-plugins.md , .../plugin-marketplaces.md

## The three pieces to build

1. **`sideshow watch` (CLI command)** — the foundation. Continuous loop of the existing
   long-poll: `GET /api/comments?session=<id>&author=user&wait=<chunk>`, print each new
   comment as one concise line, re-arm forever. Node built-ins only (CLI constraint:
   erasable TS, `.ts` ext imports, no deps). Must handle "no session yet" by retrying until
   the agent's first publish creates one. Useful standalone (`sideshow watch` in any term).

2. **The plugin package** — `monitors/monitors.json` running `sideshow watch`, plus the
   existing sideshow MCP server config and a small skill teaching the workflow ("comments
   arrive as notifications; revise the snippet or reply"). Configurable `sideshowUrl`
   (default `localhost:8228`) via `user_config`. Test with `claude --plugin-dir ./plugin`.

3. **The integrations page (viewer)** — a "Connect Claude Code" card/modal with the two
   install commands + copy buttons (reuse the existing copy affordance), a plain-English
   note on what the monitor runs (trust transparency: it runs `sideshow watch` against the
   local board, unsandboxed, no per-comment prompt), and honest caveats (needs Claude Code
   > = 2.1.105; two pasted commands, not a true one-click).

## Phasing

1. ✅ DONE — `sideshow watch` + tests (shippable on its own). Implemented in
   `bin/sideshow.js` (`watch` command + `watchLine`/`sleep` helpers); behavioral
   test in `test/cli.test.ts` boots an in-process server and asserts streaming +
   re-arm + exactly-once. Decided the **channel** question: watch carries no
   client cursor after the first poll, so it resumes from and advances the shared
   `author=user` agent cursor (`waitForComments` → `markAgentSeen`).
2. ✅ DONE — Plugin package in `plugin/`: `.claude-plugin/plugin.json` (name
   `sideshow`, `userConfig` for `sideshowUrl`/`apiToken`, inline `mcpServers`
   running `npx sideshow@latest mcp`, `experimental.monitors` → `./monitors.json`,
   `skills` → `./skills/`). `monitors.json` runs `sideshow watch` with the config
   piped in via `SIDESHOW_URL`/`SIDESHOW_TOKEN`. Plugin skill at
   `plugin/skills/sideshow/SKILL.md` teaches the notification workflow. Validated
   with `claude plugin validate ./plugin` on Claude Code 2.1.177 (✔ passed).
3. ✅ DONE — Repo-hosted marketplace at `.claude-plugin/marketplace.json` (name
   `sideshow`, plugin source relative `./plugin` — works for git-hosted
   marketplaces). Validated ✔. Docs in `README.md` ("Claude Code plugin"
   section). Install: `/plugin marketplace add modem-dev/sideshow` then
   `/plugin install sideshow@sideshow`.
4. ✅ DONE — Integrations modal in the viewer (`viewer/src/App.tsx` `ConnectModal`,
   styles in `styles.css`). Triggered from the sidebar footer ("connect Claude
   Code") and the onboarding screen. Shows both install commands (copyable),
   what the monitor runs (transparency), and honest caveats. e2e covers it
   (`e2e/viewer.spec.ts`).

## Open decisions / risks — all settled

- **Monitor = delivery channel vs. notifier.** ✅ Decided **channel** — watch
  reads with `author=user` and keeps no client cursor after the first poll, so it
  resumes from and advances the shared server-side `agentSeq` (`waitForComments`
  → `markAgentSeen`). Exactly once across paste / wait / monitor.
- **Session resolution under the monitor's process tree.** ✅ Addressed with a
  server-side fallback: `resolveSessionByCwd()` in `bin/sideshow.js` queries
  `GET /api/sessions` (which exposes `cwd` + `lastActiveAt`) and picks the most
  recently active session whose `cwd` matches `process.cwd()`, used when the
  local state file doesn't resolve a session.
- **API maturity.** `experimental.monitors` + v2.1.105 dependency — surfaced in
  the viewer modal and README as an explicit caveat. Re-verify the manifest
  contract on each Claude Code bump.
- **Don't double-run.** The plugin skill steers the agent to rely on the monitor
  rather than arming a separate `sideshow wait` loop. NOTE: `watch` is unreleased
  on npm — the plugin's `npx sideshow@latest watch` only works once a release
  including `watch` ships.

## Key code references

- `bin/sideshow.js` — CLI (Node built-ins only). `resolveSession()`, `stateFile()` (keyed by
  `sha1(agentPid:cwd)` under `$TMPDIR/sideshow-<user>/`), `agentPid()` (walks up past shells),
  existing `wait` subcommand (one-shot long-poll). `watch` goes here.
- `server/app.ts` — `waitForComments()` (long-poll + shared `agentSeq` cursor),
  `collectFeedback()` (piggyback), `GET /api/comments`. `markAgentSeen()` advances the cursor.
- `server/events.ts` — `FeedEvent` union + `EventBus` (SSE `/api/events`).
- `viewer/src/Card.tsx` + `styles.css` — composer + comment rows (where the integrations
  entry point / modal trigger would live).
- `CLAUDE.md` — invariants: exactly-once feedback delivery across channels; one shared
  cursor (`agentSeq`); CLI is Node-built-ins-only, no build step; viewer is Vite single-file.

## Next action

All four phases are implemented on `feat/comment-and-copy` (PR #16). Remaining
before this is usable end-to-end:

1. **Publish a sideshow release that includes `sideshow watch`** — the plugin's
   `npx sideshow@latest watch`/`mcp` resolve to the published package, and
   `watch` is currently unreleased.
2. **Live smoke test** with a real Claude Code session: `/plugin marketplace add`
   the branch/repo, install, publish a snippet, comment in the browser, and
   confirm the comment arrives as a notification (verifies the monitor's spawn
   tree resolves the session — `resolveSessionByCwd` is the safety net).
3. Consider pinning the marketplace plugin `source` to a tagged `ref`/`sha`
   once released, instead of tracking `main`.

---
"sideshow": patch
---

Adopt the **post / surface** vocabulary across all human-readable text: the
design/how-to guides (`guide/*.md`, `AGENTS.md`), the CLI help, usage, and
user-facing messages (`bin/sideshow.js`), and the comments and non-wire strings
in `server/*` and the residual viewer comments. The canonical hierarchy is
**workspace ▸ session ▸ post ▸ surface**: a **post** is the published artifact
(an ordered list of surfaces), a **surface** is one block inside a post, and the
tenant is a **workspace**. This is prose and CLI-help only — no behavior, API,
route, query-key, SSE-event, MCP-tool-name, or identifier changes. All
wire-bound strings (`/api/surfaces`, the `parts` body key, `?part=`,
`surface-created/updated/deleted`, the deprecated MCP tool aliases, the
`status board` kit, `--surface`) are kept byte-identical, and the CLI keeps
every endpoint and subcommand it has today (a new `--post` flag on `sideshow
comment` is added alongside the existing `--surface`/`--snippet` aliases).

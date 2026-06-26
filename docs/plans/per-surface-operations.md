# Plan: Per-surface operations across CLI / HTTP API / MCP / Viewer

Status as of 2026-06-26. Written so it's useful cold (after a context compaction).

Originates from [modem-dev/sideshow#158](https://github.com/modem-dev/sideshow/issues/158)
(CLI publish: surface order is fixed by flag identity, not command-line flag order),
but #158 is one symptom of a broader gap that spans the whole app.

## Goal

Let an agent (or human) **target the individual surfaces that compose a post** —
append, edit, remove, and reorder a single surface without re-sending the whole
`surfaces` array — consistently across all three integration tiers (CLI, HTTP,
MCP), and fix the CLI flag-order bug along the way.

## Where things stand right now (context for after a compact)

A post is an ordered list of surfaces (`server/types.ts:180`). Every tier today
treats `surfaces` as an **opaque whole-array blob**: there is no surface
identity (no stable per-surface id), no index targeting, and no per-surface
operation primitive anywhere. The server's own comment at `server/app.ts:924`
flags `"multi-surface needs --surface N"` as never-built future work.

### Current capability matrix

| Capability                              | CLI             | HTTP API     | MCP    |
| --------------------------------------- | --------------- | ------------ | ------ |
| Create post (full surfaces array)       | yes             | yes          | yes    |
| Replace all surfaces (full `PUT`)       | **not exposed** | yes          | yes    |
| Content-only edit (single-surface post) | `update`        | `PATCH`      | **no** |
| Content-only edit (multi-surface, N)    | **no (400)**    | **no (400)** | **no** |
| Append a surface to existing post       | **no**          | **no**       | **no** |
| Remove a single surface                 | **no**          | **no**       | **no** |
| Reorder surfaces                        | **no**          | **no**       | **no** |
| Flag order honored on publish           | **no (#158)**   | —            | —      |

To do any per-surface operation today, a client must read-modify-write: `GET`
the post, mutate the `surfaces` array client-side, `PUT` the whole thing back.
There is no atomic server-side primitive for append / edit-one / remove-one /
reorder.

### Key findings from the investigation

- **CLI** (`bin/sideshow.js`): `publish` builds surfaces via a hardcoded
  if-ladder (lines 824–862) in fixed order `html → markdown → mermaid → diff →
terminal → json → code → image`, regardless of flag order. The flag parser is
  `node:util` `parseArgs` (line 8), which returns a name→value object and
  discards cross-flag ordering. `update` (lines 1070–1089) is content-only,
  single-surface only — it `PATCH`es `{title, content, kits}` and the server
  rejects multi-surface posts with a 400. The CLI never calls `PUT` (full
  replace) at all — only `demo` does, via the legacy snippet route.
- **HTTP API** (`server/app.ts`): `PUT /api/posts/:id` (line 919, handler
  `revise` at 887) is full-array replacement. `PATCH /api/posts/:id` (line 934)
  is content-only but explicitly rejects posts with >1 surface (line 949). The
  shared flow function `reviseSurface` (line 466) passes `patch.parts` straight
  to `store.updatePost` as a whole `surfaces` array. No `appendSurface` /
  `removeSurface` / `updateSurfaceAt` / `reorderSurfaces` exists in the `Store`
  interface (`server/types.ts:261`) or either implementation.
- **MCP** (`server/mcpSpec.ts`, `mcp/server.ts`, `server/mcpHttp.ts`):
  `publish_post` and `update_post` take a full `surfaces` array (canonical) or
  `parts` (legacy alias). `update_post` is wholesale replace — "Pass the full
  replacement surfaces array" (`mcpSpec.ts:161`). There is **no** MCP equivalent
  of the REST `PATCH` content-only update at all. stdio MCP is a thin HTTP
  client; HTTP MCP calls the same shared flow functions as REST.
- **Viewer** (`viewer/src/Card.tsx`): purely a read-only renderer for surfaces.
  No add/remove/reorder/edit UI. Surfaces render via `<Index each={post.surfaces}>`
  (line 237) — keyed by array position, not stable identity. On `post-updated`
  SSE, `state.ts:upsertPost` (line 339) re-fetches the whole post and
  `reconcile`s it; if the version bumped, every sandboxed surface iframe reloads
  (its `src` is version-keyed). The server no longer emits
  `surface-created/updated/deleted` events — everything flows through
  `post-created`/`post-updated` (`server/events.ts`).

## Plan

### Phase 1 — Fix #158: honor CLI flag order on publish

**Scope:** `bin/sideshow.js`, `test/cli.test.ts`

The `publish` command builds surfaces via a hardcoded if-ladder that ignores the
order flags appear on the command line. `parseArgs` returns a name→value object
and discards cross-flag ordering (only within-`--kit` ordering is preserved).

**Fix:** walk the raw `process.argv` tokens (or `parseArgs`' `tokens` output,
which preserves first-appearance order) to determine the order of `--md` /
`--code` / `--diff` / `--terminal` / `--mermaid` / `--json` / `--image`, and
append surfaces in that order instead of the hardcoded cascade. The positional
html arg stays first (it's the primary content). Update the pinned test at
`test/cli.test.ts:447` to assert flag order is honored.

This is the smallest, highest-value change and ships independently.

### Phase 2 — Foundation: surface identity + server-side per-surface ops

#### 2a. Surface ids

**Scope:** `server/types.ts`, `server/storage.ts`, `server/sqlStore.ts`,
`test/storeContract.ts`

Add an optional `id: string` to every `Surface` in `server/types.ts`. Generated
server-side via `newId()` on create/update if absent. This is the foundation
that makes targeting robust — "replace surface abc" is unambiguous even across
reorders or concurrent edits.

- Migrate existing surfaces: assign ids lazily in the store's
  surface-normalization path. Both `JsonFileStore` and `SqlStore` already
  normalize legacy `snippet`/`parts` shapes on load — extend that same path.
- Support **both** id and index targeting in the API — id for robustness, index
  for curl ergonomics.
- Viewer benefit: key by surface `id` instead of `<Index>` so reordering
  doesn't reload every iframe — only moved surfaces get a new `?part=N`.

#### 2b. HTTP API per-surface endpoints

**Scope:** `server/app.ts`, `server/postSurfaces.ts`

**Extend existing PATCH** (content-only, now multi-surface):

- `PATCH /api/posts/:id` gains optional `surface: <id|index>` — when present,
  slots `content` into _that_ surface (preserving kind + extra fields like
  `language`, `cols`, `layout`). This removes the single-surface 400 at
  `app.ts:949`.

**New sub-resource routes** (canonical + legacy aliases on `/api/surfaces/:id/...`):

| Method   | Route                             | Purpose                                                            |
| -------- | --------------------------------- | ------------------------------------------------------------------ |
| `POST`   | `/api/posts/:id/surfaces`         | Append a surface. Body: `{surface, before?, after?}` for position. |
| `PATCH`  | `/api/posts/:id/surfaces/:target` | Replace one surface (full) or content-only via `{content}`.        |
| `DELETE` | `/api/posts/:id/surfaces/:target` | Remove one surface. 400 if it's the last (posts need ≥1).          |
| `PATCH`  | `/api/posts/:id/surfaces`         | Reorder. Body: `{order: [id, ...]}` or `{order: [2, 0, 1]}`.       |

`:target` is a surface id or a 0-based index.

**Shared flow functions** (REST + MCP both call these, per the existing
`publishSurface`/`reviseSurface` pattern):

- Add `appendSurface(id, surface, pos?)`, `replaceSurface(id, target,
surface|content)`, `removeSurface(id, target)`, `reorderSurfaces(id, order)`
  alongside existing `publishSurface`/`reviseSurface`.
- Each validates the single surface via `validateSurfaces([surface])`, applies
  the mutation, bumps version, pushes history, broadcasts `post-updated` SSE
  (the viewer already handles this event).

#### 2c. MCP per-surface tools

**Scope:** `server/mcpSpec.ts`, `server/mcpHttp.ts`, `mcp/server.ts`,
`test/mcpSpec.test.ts`

Add four new tools (additive — `update_post` full-replace stays for back-compat):

| Tool               | Args                                   | Maps to                                  |
| ------------------ | -------------------------------------- | ---------------------------------------- |
| `add_surface`      | `postId, surface, before?, after?`     | `POST /api/posts/:id/surfaces`           |
| `edit_surface`     | `postId, target, surface? \| content?` | `PATCH /api/posts/:id/surfaces/:target`  |
| `remove_surface`   | `postId, target`                       | `DELETE /api/posts/:id/surfaces/:target` |
| `reorder_surfaces` | `postId, order`                        | `PATCH /api/posts/:id/surfaces`          |

- Schemas: add to `HTTP_MCP_TOOLS` + `STDIO_MCP_INPUT_SCHEMAS` in `mcpSpec.ts`.
- stdio handlers in `mcp/server.ts` call the new HTTP routes (thin client
  pattern — zero business logic, same as existing tools).
- HTTP handlers in `mcpHttp.ts` call the new flow functions directly.
- This also closes the asymmetry where MCP has no content-only update at all
  (REST/CLI have PATCH, MCP doesn't).

### Phase 3 — CLI surface commands + viewer key-by-id

#### 3a. CLI surface commands

**Scope:** `bin/sideshow.js`

**Extend `update`** for multi-surface:

- `sideshow update <id> <file|-> --surface N` — content-only edit of surface N
  (by id or index). Maps to extended PATCH.
- Without `--surface`, keeps current single-surface behavior (back-compat).

**New `surface` subcommand:**

- `sideshow surface add <id> [--md f] [--code f] [--diff f] ...` — append
  surface(s) to an existing post. Uses the same flag-order fix from Phase 1.
- `sideshow surface remove <id> <N|id>` — remove a surface.
- `sideshow surface edit <id> <N|id> <file|->` — replace a surface's content.
- `sideshow surface move <id> <N|id> --to M` — reorder.

**Expose full-replace:** add a path that maps to `PUT /api/posts/:id` with a
full surfaces array (currently the CLI never calls PUT).

#### 3b. Viewer key-by-id

**Scope:** `viewer/src/Card.tsx`

- Change `<Index>` to `<For>` keyed by `surface.id` at `Card.tsx:237` — stable
  identity across reorders means only moved surfaces get a new `?part=N` render
  URL.
- The iframe `src` still uses `?part=N` (positional render index) — the server
  renders by position; the viewer maps id→position at render time.
- **No editing UI** — the viewer stays read-only for surfaces. This is correct:
  surfaces are agent-authored, and the sandboxing invariant depends on it.

## Invariants preserved

- **Legacy routes** (`/api/surfaces`, `/api/snippets`) and legacy keys (`parts`)
  stay byte-identical — new routes are additive.
- **Sandboxing rule** unchanged — no new surface kinds in this work, and any
  future kind still picks (a) string-served sandbox or (b) native data render.
- **`update_post` full-replace** stays for back-compat; new MCP tools are
  additive.
- **Store contract test** (`test/storeContract.ts`) covers the new operations
  on both `JsonFileStore` and `SqlStore`.
- **Post version bump + `post-updated` SSE** on every per-surface mutation —
  the viewer already re-fetches and reconciles on this event.
- **Runtime-agnostic** — new flow functions and routes in `server/app.ts` stay
  free of `node:` imports; stdio MCP stays a thin HTTP client.

## Suggested implementation sequence

1. **P1** (standalone, ships first): CLI flag-order fix — `bin/sideshow.js` +
   test update + changeset.
2. **P2a**: Surface ids in `types.ts` + store migration + store contract tests.
3. **P2b**: HTTP per-surface endpoints + flow functions + API tests.
4. **P2c**: MCP per-surface tools + `mcpSpec` test.
5. **P3a**: CLI `surface` subcommand + `update --surface N`.
6. **P3b**: Viewer key-by-id.

Each phase is independently shippable with a changeset. P1 is the #158 fix;
P2 is the API/MCP gap; P3 is CLI ergonomics + viewer polish.

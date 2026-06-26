---
"sideshow": minor
---

Per-surface operations across CLI, HTTP API, and MCP. Surfaces now carry
stable server-assigned ids for targeted operations.

**CLI**

- `sideshow publish` now honors flag order: surfaces appear in the order
  their `--md` / `--code` / `--diff` / etc. flags appear on the command line,
  not a fixed sequence (fixes #158).
- `sideshow update <id> <file|-> --surface N` targets a specific surface in a
  multi-surface post (by id or 0-based index) for content-only edits.
- New `sideshow surface` subcommand:
  - `surface add <postId> [--md f] [--code f] ...` — append surfaces to an
    existing post (flag order honored).
  - `surface remove <postId> <N|id>` — remove a single surface.
  - `surface edit <postId> <N|id> <file|->` — replace a surface's content.
  - `surface move <postId> <N|id> --to M` — reorder a surface.

**HTTP API**

- `POST /api/posts/:id/surfaces` — append a surface (optional `before`/`after`
  for insert position).
- `PATCH /api/posts/:id/surfaces/:target` — replace a surface (full or
  content-only). `:target` is a surface id or 0-based index.
- `DELETE /api/posts/:id/surfaces/:target` — remove a surface (400 if last).
- `PATCH /api/posts/:id/surfaces` — reorder surfaces. Body: `{order: [id, ...]}`
  or `{order: [2, 0, 1]}`.
- `PATCH /api/posts/:id` extended: optional `surface` param targets a specific
  surface in multi-surface posts (previously rejected with 400).

**MCP**

- New tools: `add_surface`, `edit_surface`, `remove_surface`,
  `reorder_surfaces` — all additive; `update_post` full-replace stays for
  back-compat. Available on both stdio and HTTP MCP transports.

**Data model**

- Every surface now carries an optional `id: string`, assigned server-side on
  create/update. Existing data is migrated automatically (one-time migration
  on first boot, gated on a settings sentinel for SqlStore; in-memory
  normalization on load for JsonFileStore).

**Viewer**

- Surfaces are keyed by stable `id` (Solid `<For>` with `reconcile({ key: "id"
})`) instead of array position, so reordering moves DOM nodes instead of
  re-creating them.

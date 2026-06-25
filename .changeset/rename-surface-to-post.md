---
"sideshow": minor
---

Rename the data model: the published artifact `Surface` → `Post`, and its blocks (`SurfacePart` and the `*Part` variants) → `Surface`. The block field `parts` → `surfaces`, and comment links `surfaceId`/`surfaceTitle` → `postId`/`postTitle`. Exported types, `Store` methods (`listSurfaces`→`listPosts`, …), and helpers (`htmlPart`→`htmlSurface`, `MAX_BOARD_ASSET_BYTES`→`MAX_WORKSPACE_ASSET_BYTES`, `BoardSnapshot`→`WorkspaceSnapshot`) are renamed to match — **a breaking change for library consumers importing these names.**

SQLite boards migrate in place via a new idempotent `migrateToPosts()` (table `surfaces`→`posts`, column `parts`→`surfaces`, comment columns renamed, history blob re-keyed), mirroring the JSON store's read-time shims. Existing data is preserved.

Wire: full-object reads `GET /api/surfaces/:id` and `GET`/`POST` `/api/comments` now emit the renamed fields (`surfaces`, `postId`/`postTitle`). Route paths and MCP tool names are unchanged in this release.

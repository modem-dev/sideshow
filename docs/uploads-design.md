# Design: agent-driven uploads (assets, images, traces)

Status: implemented. Audience: sideshow maintainers/agents. This documents the
design and the decisions behind it; the code lives across `server/`, `workers/`,
`viewer/src/`, `bin/`, and `mcp/`.

## Goal

Let agents push binary and structured artifacts — images, screenshots, agent
traces, arbitrary files — over all three tiers (CLI, MCP, raw HTTP), and surface
them in the viewer. Two motivating flows:

1. **Embed an uploaded image in a visualization.** An agent generates a PNG/SVG,
   uploads it once, gets back a URL, and references it from an `html` part
   (`<img src="…">`).
2. **Agent traces.** An agent uploads a trace of its run and the viewer renders
   it as a step timeline _next to_ the visualization, so the user can see what
   the agent did at each step — and/or downloads it for later analysis.

This keeps faith with the product stances in `AGENTS.md`: the publish → render →
comment → revise loop is the product, every feature works on all three tiers,
and the runtime-agnostic server files stay free of `node:` imports.

## Why a separate "asset" entity (not bytes inside a part)

A surface is an ordered list of parts capped at `MAX_SURFACE_BYTES` (2 MB), and
`partsByteLength()` counts raw string length. The card-list read path strips
`html` bodies out (`stripParts`) precisely so it never ships large markup. Binary
blobs (often base64-inflated by ~33%) do not belong inside that JSON:

- a 1.5 MB screenshot would blow the surface limit meant to bound _markup_;
- every `list_surfaces` / SSE meta read would drag the bytes around;
- the same image embedded in two surfaces would be stored twice.

So assets are a **first-class entity stored apart from surfaces**, referenced by
id. Parts stay tiny (a reference + presentation hints); the 2 MB surface limit
keeps meaning "markup size".

## Data model

New entity in `server/types.ts` (no runtime imports — safe for both runtimes):

```ts
export type AssetKind = "image" | "trace" | "file";

export interface Asset {
  id: string;
  sessionId: string; // scopes lifetime + cascade delete
  kind: AssetKind; // hint for the viewer; "file" is the catch-all
  contentType: string; // e.g. "image/png", "application/json"
  byteLength: number; // decoded size (what limits check against)
  filename: string | null; // original name, for downloads
  data: Uint8Array; // raw bytes (see "Storage" — BLOB / on-disk base64)
  createdAt: string;
  lastAccessedAt: string; // bumped on serve; drives LRU eviction
}

export interface CreateAssetInput {
  sessionId: string;
  kind?: AssetKind; // inferred from contentType when omitted
  contentType: string;
  filename?: string;
  data: Uint8Array; // raw bytes
}
```

The `Store` interface speaks **bytes** (`Uint8Array`), not base64. base64 is an
edge-only encoding (HTTP base64-JSON body, MCP tool args) decoded before it
reaches the store, and an on-disk detail of `JsonFileStore` (JSON can't hold
binary). `Uint8Array` is a standard-lib type, so `types.ts` stays
runtime-agnostic. `Store` gains (added to `test/storeContract.ts` so both stores
prove identical behavior):

```ts
putAsset(input: CreateAssetInput): Promise<Asset | null>;  // null if session missing; evicts to fit
getAsset(id: string): Promise<Asset | null>;
touchAsset(id: string): Promise<void>;                     // bump lastAccessedAt (called on serve)
listAssets(sessionId: string): Promise<Asset[]>;           // for the viewer/debug
removeAsset(id: string): Promise<boolean>;
boardAssetBytes(): Promise<number>;                        // total, for the budget check
referencedAssetIds(): Promise<Set<string>>;                // image/trace assetIds across live surfaces + history
```

Cascade: `removeSession` deletes its assets. Assets are session-scoped, not
surface-scoped, because one upload may be embedded by several surfaces (and by
later revisions of the same surface).

### Two new part kinds (rendered natively by the trusted viewer, like `diff`)

```ts
export interface ImagePart {
  kind: "image";
  assetId: string;
  alt?: string;
  caption?: string;
}

// Inline trace: steps travel in the part (small, structured). Uploaded trace:
// `assetId` points at a JSON/JSONL file rendered + offered for download.
// At least one of `steps` / `assetId` is present.
export interface TraceStep {
  label: string; // one-line summary, e.g. "read server/app.ts"
  kind?: string; // free tag: "tool" | "thought" | "shell" | …
  detail?: string; // expandable body (output, args, reasoning)
  ts?: string; // ISO timestamp, optional
}
export interface TracePart {
  kind: "trace";
  steps?: TraceStep[];
  assetId?: string; // large/raw trace file, downloadable
  title?: string;
}

export type SurfacePart = HtmlPart | DiffPart | ImagePart | TracePart;
```

`partsByteLength()` extends to count `image`/`trace` parts (refs + inline steps
are small; the asset bytes are bounded separately). `firstHtml`/`stripParts`
stay correct — image/trace parts are structured data, passed through untouched
like `diff`.

## Storage

Asset bytes live in the store (no R2): the one Durable Object's SQLite on
Cloudflare, the JSON file locally. The bytes are held as native binary —
`Uint8Array` in memory and across the `Store` interface — and only get
base64-encoded at the two text boundaries (HTTP base64-JSON bodies, MCP args,
and `JsonFileStore`'s on-disk JSON).

- **`SqlStore`**: a new table with a `BLOB` `data` column — 33% smaller than
  base64 TEXT and no decode-on-serve, which directly helps the shared ~10 GB DO
  ceiling. DO SQLite stores blobs natively; the `node:sqlite` adapter
  (`server/sqliteStorage.ts`) binds `Uint8Array` for BLOB columns, since
  `node:sqlite` already round-trips blobs.

  ```sql
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, kind TEXT NOT NULL,
    contentType TEXT NOT NULL, byteLength INTEGER NOT NULL, filename TEXT,
    data BLOB NOT NULL, createdAt TEXT NOT NULL, lastAccessedAt TEXT NOT NULL
  );
  ```

  Migration is **purely additive** (a new table) — no in-place rewrite of
  existing rows, so the "deployed DOs can't be reset" rule is satisfied by the
  `CREATE TABLE IF NOT EXISTS` alone.

- **`JsonFileStore`**: a new `assets[]` entry in the file shape. `Uint8Array`
  can't live in JSON, so persist/load convert `data` to/from base64 explicitly
  (the rest of the record is plain JSON). In memory the store still hands back
  live `Uint8Array`s.

### Limits and eviction (resolved)

- **Per-asset cap `MAX_ASSET_BYTES` = 5 MB** (decoded). Uploads over it → 413.
- **Per-board budget `MAX_BOARD_ASSET_BYTES` ≈ 2 GB**, well under the DO's ~10 GB
  ceiling with headroom for surfaces/comments. There is a single DO for the whole
  deployment (`idFromName("default")`), so this budget is board-wide.
- **Reference-aware LRU eviction.** When a new upload would exceed the board
  budget, `putAsset` evicts existing assets oldest-`lastAccessedAt`-first to make
  room — but partitioned so **unreferenced** assets go first and an asset still
  referenced by a live surface part is only evicted as a true last resort (when
  unreferenced candidates are exhausted). `referencedAssetIds()` collects every
  `image`/`trace` `assetId` across current surfaces _and_ their history versions.

  This honors the chosen "auto-evict oldest" behavior while containing its blast
  radius. Two safeguards keep eviction from being an _invisible_ break (the
  codebase's "feedback/▢ never silently lost" ethos):
  - **`lastAccessedAt` is bumped on every `GET /a/:id`**, so any asset whose
    surface is actually being viewed stays "warm" and sorts last for eviction —
    this also protects raw-URL `<img>` embeds that `referencedAssetIds()` can't
    see (an html part's markup isn't parsed for asset URLs).
  - The viewer renders a clear **"asset evicted to reclaim space"** placeholder
    for any `image`/`trace` part whose `assetId` 404s, rather than a broken
    image. (Caching note: `/a/:id` uses short/revalidating cache rather than
    `immutable`, so the touch-on-serve actually fires; asset ids are unique so
    correctness doesn't depend on long caching.)

  Residual gap: a raw-URL embed in an html part whose surface is _never_ viewed
  for a long time could still be evicted under sustained pressure. For
  guaranteed-retention embeds, prefer an `image` part (tracked) over a raw
  `<img src>` — documented in the design guide.

## HTTP API

```
POST /api/assets
  - raw bytes:  Content-Type: image/png        (body = bytes)
                optional ?session=<id>&filename=<name>&kind=<kind>
  - or JSON:    { data: "<base64>", contentType, filename?, kind?, session? }
  -> 201 { id, url, contentType, byteLength, kind }   url = "<origin>/a/<id>"
  -> 413 if byteLength > MAX_ASSET_BYTES
  -> 404 if an explicit session id is unknown
GET /a/:id
  -> 200 bytes, X-Content-Type-Options: nosniff, short revalidating cache,
         Content-Type + Content-Disposition per the policy below; bumps
         lastAccessedAt (LRU)
  -> 404 if missing (viewer shows the "evicted" placeholder)
```

### Content-type serving policy (resolved)

`/a/:id` must never be coercible into a live, same-origin, script-executing
document. Policy:

- **Inline allowlist (raster images only):** `image/png`, `image/jpeg`,
  `image/gif`, `image/webp`, `image/avif` are served with their real
  `Content-Type` and `Content-Disposition: inline`.
- **Everything else** — `image/svg+xml`, `application/json`, `text/plain`,
  `text/csv`, and the `application/octet-stream` catch-all — is served with
  `Content-Disposition: attachment; filename="<name>"`. Unknown or dangerous
  types (`text/html`, anything not on a small known list) are normalized to
  `application/octet-stream`.
- `X-Content-Type-Options: nosniff` always.

This loses nothing in practice: `<img src>` and `fetch()` both ignore
`Content-Disposition`, so SVGs still embed via `<img>` and trace JSON still
renders inline in the viewer — but a top-level navigation to `/a/:id` can never
execute an uploaded SVG/HTML as a same-origin script; it downloads instead.

Session handling mirrors `publishSurface`: an explicit `session` is validated;
otherwise (raw `curl` ergonomics) one is auto-created so an upload can precede
the first publish. Both raw-binary and base64-JSON inputs are accepted so a
shell `curl --data-binary @img.png` and a JSON client both work.

A shared `uploadAsset()` flow in `server/app.ts` (alongside `publishSurface`
etc.) backs both REST and MCP, matching the existing pattern.

### Auth & embedding

`/api/assets` and `/a/:id` sit under the existing auth middleware. Embedding
works because the sandboxed `/s/:id` document is served from the server's own
origin, so an `<img src="/a/:id">` (or absolute same-origin URL) is a
same-origin request that carries the `sideshow_key` cookie. No new auth surface,
no public/unauthenticated asset route.

## CSP change (the one subtlety for embedding)

`server/surfacePage.ts` today allows `img-src https: data: blob:`. That covers
`data:` URIs and HTTPS deployments, but **not** local `http://localhost`, and
`'self'` is useless inside an `allow-same-origin`-less sandbox (opaque origin).
To let agents embed a _served_ asset by URL on every deployment:

- thread the request origin into `renderHtmlPage({ title, html, origin })` from
  the `/s/:id` route (it already has `c.req.url`);
- add that origin to `img-src` and `media-src` (keeping `https: data: blob:`).

Everything else in the CSP is unchanged. `data:` embedding keeps working with no
upload at all (good for tiny inline images), and the design guide documents both
paths. Note the invariant: the iframe sandbox stays without `allow-same-origin`
— this change widens an allowlist, it does not relax the sandbox.

## Viewer

`viewer/src/Card.tsx` renders parts in order; `image`/`trace` join `diff` as
natively-rendered (trusted) parts — no iframe:

- **`ImagePart.tsx`**: `<img src="/a/{assetId}" alt>` with optional caption,
  width-constrained to the card column, lazy-loaded; click → open `/a/:id` in a
  new tab.
- **`TracePart.tsx`**: a compact step timeline (label + optional kind tag +
  timestamp), each row expandable to its `detail`. When `assetId` is present,
  show a "Download trace" link to `/a/:id`. When only `assetId` is present (no
  inline `steps`), fetch + render a summary, still offering the download. This
  satisfies "render inline next to the viz" and "download for later" in one part.

`viewer/src/api.ts` re-exports the new types; `state.ts`/event handling need no
changes (assets ride inside surfaces; `surface-created`/`-updated` events already
refresh the card).

## Tiers

**CLI** (`bin/sideshow.js`, Node built-ins only):

```
sideshow upload <file> [--session <id>] [--kind image|trace|file]
    -> { id, url }                         # upload once, embed/reference by url
sideshow image <file> --title "…" [--caption "…"]
    -> publishes a surface with one image part (upload + publish in one shot)
sideshow publish sketch.html --image shot.png --title "…"
    -> uploads shot.png and emits an image part after the html part
sideshow trace <file.json|-> --title "…"
    -> uploads + publishes a trace part (download link + inline if parseable)
```

`upload` reads the file as bytes and POSTs raw with the detected content-type
(by extension; `application/octet-stream` fallback).

**MCP** (`server/mcpHttp.ts` + stdio passthrough in `mcp/server.ts`):

- new tool `upload_asset { data (base64), contentType, filename?, kind?,
session? } -> { id, url, byteLength }`. Base64 is required because MCP is
  JSON-RPC (no binary frames).
- `coerceParts()` extended to accept `image` and `trace` parts; `PARTS_SCHEMA`
  documents them so `publish_surface` / `update_surface` can include them.
- `INSTRUCTIONS` + `get_design_guide` updated to mention uploads.

**HTTP**: as specified above.

All three converge on the same `uploadAsset()` flow and the same part shapes, so
behavior is identical regardless of tier — the existing "features work on all
three tiers" stance.

## Docs to update

- `guide/DESIGN_GUIDE.md`: new part kinds, the upload→embed flow, the CSP note
  (served assets now embeddable by URL, not only `https:`/`data:`).
- `guide/AGENT_SETUP.md` / `AGENTS.md` map: mention `/api/assets`, `/a/:id`,
  `upload_asset`, and the new CLI verbs.
- A Changesets release-note fragment (`npm run changeset`).

## Tests

- `test/storeContract.ts`: put/get/list/remove assets; session cascade;
  `touchAsset` bumps `lastAccessedAt`; `boardAssetBytes`/`referencedAssetIds`;
  reference-aware eviction (unreferenced evicted before referenced, oldest-first;
  a referenced asset survives while unreferenced candidates exist). Both stores
  run it, so BLOB (SqlStore via the widened shim) and base64-on-disk
  (JsonFileStore) round-trip identical bytes.
- API tests: upload (raw + base64), per-asset 413, the content-type serving
  policy (raster inline; svg/json/html → attachment + octet-stream + nosniff),
  unknown id 404, auto-session, auth required.
- `coerceParts` unit coverage for `image`/`trace` (including dropping malformed
  parts, per existing lenient behavior).
- e2e: publish a surface with an image part (assert `<img>` renders) and a trace
  part (assert timeline rows + download link); embed-by-URL inside an html part
  renders under the widened CSP on both chromium and webkit.

## Resolved decisions

These were the doc's open questions; each is now settled (see the sections above
for the mechanics).

1. **Blob backend → in-DO SQLite (`BLOB`), no R2.** Keeps the "both stores pass
   one contract, zero-config local" invariant; bytes ride as `Uint8Array`
   through the core, base64 only at the text edges. Cost: extend the
   `node:sqlite` shim to bind `Uint8Array`. Ceiling: the single deployment DO's
   ~10 GB, mitigated by the board budget + eviction below. R2 stays the
   documented escape hatch if asset volume ever outgrows one DO.
2. **Storage budget → auto-evict oldest, made reference-aware.** Per-asset cap
   5 MB; per-board budget ~2 GB; `putAsset` evicts oldest-`lastAccessedAt`-first
   to fit, unreferenced assets before referenced ones. `lastAccessedAt` bumps on
   serve so visible assets (incl. raw-URL embeds) stay warm, and the viewer shows
   an explicit "evicted" placeholder for any dead `assetId` — so eviction never
   silently breaks a card. Residual gap (long-unviewed raw-URL embeds under
   sustained pressure) is documented; prefer an `image` part for guaranteed
   retention.
3. **Asset lifetime → session-scoped.** Cleaned up with the session (matches the
   surface/comment cascade), never with an individual surface — one upload may be
   embedded by several surfaces/revisions, and raw-URL embeds have no
   store-visible back-reference. Documented in the design guide.
4. **Content-type trust → inline raster-image allowlist; everything else
   `attachment` + `nosniff`.** `text/html` and unknowns normalize to
   `application/octet-stream`. `<img>`/`fetch` ignore `Content-Disposition`, so
   embedding (incl. SVG) and inline trace rendering keep working while a
   top-level open of `/a/:id` can never execute an uploaded document.

Remaining (genuinely v2, not blockers): an R2 backend if one DO is outgrown; a
per-session quota in addition to the board budget; and richer trace formats
(e.g. streaming/append) beyond the upload-once model.

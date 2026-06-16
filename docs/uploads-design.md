# Design: agent-driven uploads (assets, images, traces)

Status: proposal (no code yet). Audience: sideshow maintainers/agents.

## Goal

Let agents push binary and structured artifacts — images, screenshots, agent
traces, arbitrary files — over all three tiers (CLI, MCP, raw HTTP), and surface
them in the viewer. Two motivating flows:

1. **Embed an uploaded image in a visualization.** An agent generates a PNG/SVG,
   uploads it once, gets back a URL, and references it from an `html` part
   (`<img src="…">`).
2. **Agent traces.** An agent uploads a trace of its run and the viewer renders
   it as a step timeline *next to* the visualization, so the user can see what
   the agent did at each step — and/or downloads it for later analysis.

This keeps faith with the product stances in `AGENTS.md`: the publish → render →
comment → revise loop is the product, every feature works on all three tiers,
and the runtime-agnostic server files stay free of `node:` imports.

## Why a separate "asset" entity (not bytes inside a part)

A surface is an ordered list of parts capped at `MAX_SURFACE_BYTES` (2 MB), and
`partsByteLength()` counts raw string length. The card-list read path strips
`html` bodies out (`stripParts`) precisely so it never ships large markup. Binary
blobs (often base64-inflated by ~33%) do not belong inside that JSON:

- a 1.5 MB screenshot would blow the surface limit meant to bound *markup*;
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
  sessionId: string;          // scopes lifetime + cascade delete
  kind: AssetKind;            // hint for the viewer; "file" is the catch-all
  contentType: string;        // e.g. "image/png", "application/json"
  byteLength: number;         // decoded size (what limits check against)
  filename: string | null;    // original name, for downloads
  data: string;               // base64 of the raw bytes (see "Storage" below)
  createdAt: string;
}

export interface CreateAssetInput {
  sessionId: string;
  kind?: AssetKind;           // inferred from contentType when omitted
  contentType: string;
  filename?: string;
  data: string;               // base64
}
```

`Store` gains (added to `test/storeContract.ts` so both stores prove identical
behavior):

```ts
putAsset(input: CreateAssetInput): Promise<Asset | null>;  // null if session missing
getAsset(id: string): Promise<Asset | null>;
listAssets(sessionId: string): Promise<Asset[]>;           // for the viewer/debug
removeAsset(id: string): Promise<boolean>;
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
  label: string;              // one-line summary, e.g. "read server/app.ts"
  kind?: string;              // free tag: "tool" | "thought" | "shell" | …
  detail?: string;           // expandable body (output, args, reasoning)
  ts?: string;               // ISO timestamp, optional
}
export interface TracePart {
  kind: "trace";
  steps?: TraceStep[];
  assetId?: string;           // large/raw trace file, downloadable
  title?: string;
}

export type SurfacePart = HtmlPart | DiffPart | ImagePart | TracePart;
```

`partsByteLength()` extends to count `image`/`trace` parts (refs + inline steps
are small; the asset bytes are bounded separately). `firstHtml`/`stripParts`
stay correct — image/trace parts are structured data, passed through untouched
like `diff`.

## Storage

Both stores keep their everything-as-JSON shape; `data` is base64 text.

- **`JsonFileStore`**: a new `assets: Asset[]` array in the file shape, persisted
  like the rest. Base64 in the JSON file is fine for local single-user use.
- **`SqlStore`**: a new table. Start with base64 `TEXT` to mirror the JSON store
  exactly and keep the contract simple; a `BLOB` column is a possible later
  optimization (the `node:sqlite` contract shim and DO SQLite both support
  blobs, but TEXT avoids shim/typing friction now).

  ```sql
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, kind TEXT NOT NULL,
    contentType TEXT NOT NULL, byteLength INTEGER NOT NULL, filename TEXT,
    data TEXT NOT NULL, createdAt TEXT NOT NULL
  );
  ```

  Migration is **purely additive** (a new table) — no in-place rewrite of
  existing rows, so the "deployed DOs can't be reset" rule is satisfied by the
  `CREATE TABLE IF NOT EXISTS` alone.

Limits: a separate `MAX_ASSET_BYTES` (proposed 5 MB). Per-session and/or
per-board ceilings are a possible follow-up to bound a Durable Object's total
size; out of scope for v1.

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
  -> 200 with Content-Type, Content-Disposition (inline; filename),
         X-Content-Type-Options: nosniff, long-lived immutable cache
  -> 404 if missing
```

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
To let agents embed a *served* asset by URL on every deployment:

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
- `CHANGELOG.md` under `[Unreleased] / Added`.

## Tests

- `test/storeContract.ts`: put/get/list/remove assets; session cascade; both
  stores run it.
- API tests: upload (raw + base64), size-limit 413, serve content-type +
  disposition + nosniff, unknown id 404, auto-session, auth required.
- `coerceParts` unit coverage for `image`/`trace` (including dropping malformed
  parts, per existing lenient behavior).
- e2e: publish a surface with an image part (assert `<img>` renders) and a trace
  part (assert timeline rows + download link); embed-by-URL inside an html part
  renders under the widened CSP on both chromium and webkit.

## Risks / open questions

- **DO storage growth.** Base64 assets live in the Durable Object's SQLite. With
  no per-board ceiling a board could grow unbounded. v1 relies on
  `MAX_ASSET_BYTES` per asset; a per-session/board quota + an eviction story is a
  recommended fast follow.
- **`TEXT` vs `BLOB`.** Base64 in TEXT is ~33% larger and costs an
  encode/decode. Chosen for store/shim symmetry now; revisit if asset volume
  matters.
- **Asset lifetime.** Session-scoped feels right (matches surface/comment
  cascade), but an asset embedded in an html part by *raw URL* (not an image
  part) has no referential link the store can see — deleting a surface won't
  orphan-collect it, and that's intended (assets outlive any single surface).
  Document that assets are cleaned up with the session, not the surface.
- **Content-type trust.** `/a/:id` serves the stored content-type with `nosniff`;
  we should constrain/normalize it (allow an image/* + a small text/JSON set,
  fall back to `application/octet-stream` + `Content-Disposition: attachment`)
  so an uploaded `text/html` asset can't be served as a live same-origin
  document. Worth nailing down before implementation.
```

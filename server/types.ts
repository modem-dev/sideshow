// Shared data model — no runtime imports, safe for any platform.

export interface Session {
  id: string;
  agent: string;
  title: string | null;
  cwd: string | null;
  createdAt: string;
  lastActiveAt: string;
  // Highest comment seq already delivered to the agent — lets responses to
  // agent writes piggyback comments the agent has not seen yet.
  agentSeq: number;
}

// A surface is an ordered list of parts. Each part declares its own kind;
// the surface itself is kind-agnostic. An `html` part is arbitrary agent
// markup (rendered sandboxed in an iframe); `diff`, `image`, `trace`,
// `markdown`, `terminal`, and `mermaid` parts are structured data rendered by
// the trusted viewer. A snippet is just a surface with one html part; a
// diagram-with-its-diff is `[html, diff]`.
export type SurfacePartKind =
  | "html"
  | "diff"
  | "image"
  | "trace"
  | "markdown"
  | "terminal"
  | "mermaid"
  | "json"
  | "code";

export interface HtmlPart {
  kind: "html";
  html: string;
  // Opt-in style/behavior bundles (see kits.ts). The sandbox doc gets each
  // listed kit's CSS/JS injected after the base kit; omit for plain html.
  kits?: string[];
}

// A markdown part is prose the trusted viewer renders — explanations, plans,
// tradeoff write-ups. Unlike an html part it is NOT sandboxed: the viewer
// renders it to HTML in its own origin, so raw HTML embedded in the source is
// escaped, not executed (see MarkdownPart.tsx). Agents wanting live markup use
// an html part instead.
export interface MarkdownPart {
  kind: "markdown";
  markdown: string;
}

// A mermaid part is diagram source (flowchart, sequence, ERD, gantt, …) the
// trusted viewer renders to SVG with the mermaid library. Like markdown it is
// NOT sandboxed: mermaid renders in the viewer's own origin with
// securityLevel 'strict', sanitizing the SVG and disabling scripts/HTML labels
// (see MermaidPart.tsx). Agents wanting hand-drawn vector art use an html part
// with inline <svg> instead.
export interface MermaidPart {
  kind: "mermaid";
  mermaid: string;
}

export interface DiffFile {
  filename: string;
  before: string;
  after: string;
  // Shiki language id; inferred from the filename when omitted.
  language?: string;
}

export interface DiffPart {
  kind: "diff";
  // A unified/git patch (may span multiple files) and/or explicit before/after
  // file pairs. At least one must be present; the viewer prefers `patch`.
  patch?: string;
  files?: DiffFile[];
  layout?: "unified" | "split";
}

// An image part references an uploaded asset by id; the trusted viewer renders
// it as a plain <img> in its own chrome (no iframe). Agents can also embed the
// asset's URL inside an html part instead — both paths resolve to /a/:id.
export interface ImagePart {
  kind: "image";
  assetId: string;
  alt?: string;
  caption?: string;
}

// One step in an agent trace. `label` is the one-line summary; `detail` is the
// expandable body (tool output, args, reasoning). Everything else is optional.
export interface TraceStep {
  label: string;
  kind?: string;
  detail?: string;
  ts?: string;
}

// A trace part renders a step timeline the viewer shows beside the surface.
// `steps` travel inline (small, structured); `assetId` points at a larger
// uploaded trace file (JSON/JSONL), offered for download and rendered when it
// parses. At least one of the two is present.
export interface TracePart {
  kind: "trace";
  steps?: TraceStep[];
  assetId?: string;
  title?: string;
}

// A terminal part renders monospace terminal output the viewer styles as a
// terminal window. `text` travels inline (like html) — raw output that may
// carry ANSI SGR escapes (colors/bold/italic); the viewer converts those to
// styled spans and HTML-escapes everything else. `cols` is an optional render
// width hint; `title` labels the window chrome. The renderer is intentionally
// SGR-only for now (cursor-addressing TUIs aren't resolved) — the wire shape
// is renderer-agnostic so a full VT emulator can replace it later.
export interface TerminalPart {
  kind: "terminal";
  text: string;
  cols?: number;
  title?: string;
}

// A json part is a pre-parsed JSON value the trusted viewer renders as a
// collapsible tree (objects/arrays expand and collapse; primitives show inline).
// Like image/trace it is DATA, not markup: the viewer renders it with Solid
// text nodes, which escape by construction — so agent-authored JSON can never
// execute in the trusted viewer origin, and no sandboxed iframe is needed.
// `data` is `unknown` (any JSON value, including null); the wire body already
// parsed it, so the viewer never needs to JSON.parse.
export interface JsonPart {
  kind: "json";
  data: unknown;
}

// A code part is source code the trusted viewer highlights with shiki (the
// same highlighter MarkdownPart uses for fenced code blocks) and renders in a
// sandboxed iframe. Like markdown/mermaid it is DATA, not markup: the viewer
// produces the HTML string via shiki, then SandboxedPart parses it inside an
// opaque-origin iframe. `language` is a shiki lang id (ts, js, python, rust,
// go, ...); omit or use "text" for plain monospace. `title` is an optional
// label (e.g. a filename) shown above the code.
export interface CodePart {
  kind: "code";
  code: string;
  language?: string;
  title?: string;
  // 1-based line number the displayed code starts at (e.g. 80 for "lines
  // 80-150 of x.ts"). The viewer renders line numbers starting here instead
  // of 1, so an agent can show an excerpt with its original line numbers.
  lineStart?: number;
}

export type SurfacePart =
  | HtmlPart
  | DiffPart
  | ImagePart
  | TracePart
  | MarkdownPart
  | TerminalPart
  | MermaidPart
  | JsonPart
  | CodePart;

export interface SurfaceVersion {
  version: number;
  title: string;
  parts: SurfacePart[];
  at: string;
}

export interface Surface {
  id: string;
  sessionId: string;
  title: string;
  parts: SurfacePart[];
  createdAt: string;
  updatedAt: string;
  version: number;
  history: SurfaceVersion[];
}

export interface Comment {
  id: string;
  seq: number;
  sessionId: string;
  surfaceId: string | null;
  surfaceTitle: string | null;
  author: string;
  text: string;
  createdAt: string;
}

// An uploaded blob (image, trace file, arbitrary file) the agent pushes once and
// references by id. Stored apart from surfaces so binary never bloats the parts
// JSON or the 2 MB surface limit. `data` is raw bytes — base64 is an edge-only
// encoding (HTTP/MCP request bodies, JsonFileStore's on-disk JSON).
export type AssetKind = "image" | "trace" | "file";

export interface Asset {
  id: string;
  sessionId: string;
  kind: AssetKind;
  contentType: string;
  byteLength: number;
  filename: string | null;
  data: Uint8Array;
  createdAt: string;
  // Bumped on each serve; drives the reference-aware LRU eviction below.
  lastAccessedAt: string;
}

export interface CreateAssetInput {
  sessionId: string;
  kind: AssetKind;
  contentType: string;
  filename?: string;
  data: Uint8Array;
}

export interface CreateSessionInput {
  agent: string;
  title?: string;
  cwd?: string;
}

export interface CreateSurfaceInput {
  sessionId: string;
  title?: string;
  parts: SurfacePart[];
}

export interface UpdateSurfaceInput {
  title?: string;
  parts?: SurfacePart[];
}

export interface CreateCommentInput {
  sessionId: string;
  surfaceId?: string;
  author: string;
  text: string;
}

export interface CommentQuery {
  sessionId?: string;
  surfaceId?: string;
  afterSeq?: number;
}

// Storage interface — implementations: JsonFileStore (local Node),
// SqlStore (Cloudflare Durable Object SQLite).
export interface Store {
  listSessions(): Promise<Session[]>;
  getSession(id: string): Promise<Session | null>;
  createSession(input: CreateSessionInput): Promise<Session>;
  renameSession(id: string, title: string): Promise<Session | null>;
  removeSession(id: string): Promise<boolean>;
  // Advance the delivered-to-agent comment cursor (never moves backwards).
  markAgentSeen(sessionId: string, seq: number): Promise<void>;

  // Board-level key/value settings (e.g. the selected theme id). Returns null
  // for an unset key.
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  listSurfaces(sessionId?: string): Promise<Surface[]>;
  getSurface(id: string): Promise<Surface | null>;
  createSurface(input: CreateSurfaceInput): Promise<Surface | null>;
  updateSurface(id: string, patch: UpdateSurfaceInput): Promise<Surface | null>;
  removeSurface(id: string): Promise<boolean>;

  listComments(query: CommentQuery): Promise<Comment[]>;
  createComment(input: CreateCommentInput): Promise<Comment | null>;

  // Session-scoped agent trace: the steps that produced a session's surfaces,
  // synced from the transcript. setTrace replaces the whole list (windowed
  // syncs re-send the full slice); removeSession cascades it.
  listTrace(sessionId: string): Promise<TraceStep[]>;
  setTrace(sessionId: string, steps: TraceStep[]): Promise<void>;

  // Assets. putAsset evicts to stay under MAX_BOARD_ASSET_BYTES (see
  // selectEvictions) and returns null only if the session is missing.
  putAsset(input: CreateAssetInput): Promise<Asset | null>;
  getAsset(id: string): Promise<Asset | null>;
  // Bump lastAccessedAt (called when bytes are served), keeping live assets warm.
  touchAsset(id: string): Promise<void>;
  listAssets(sessionId: string): Promise<Asset[]>;
  removeAsset(id: string): Promise<boolean>;
  // Whether any live surface (current or historical version) references this
  // asset id. Drives the optimistic-read wait and reference-aware deletion.
  isAssetReferenced(id: string): Promise<boolean>;
}

export const HISTORY_LIMIT = 20;

// Per-asset upload cap (enforced at the HTTP/MCP edge → 413) and the board-wide
// budget the store evicts down to. One Durable Object holds the whole board, so
// the budget sits well under its ~10 GB SQLite ceiling.
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_BOARD_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

// Short, unguessable id: 8 random bytes (64 bits) as 11 url-safe base64 chars —
// YouTube-video-id sized. These double as bearer capabilities: in publicRead
// mode `/s/:id` and `/api/{sessions,surfaces}/:id` are reachable without the
// board token, so the id IS the share secret and must resist enumeration. 64
// bits (~1.8e19) is far past sweepable; the old `randomUUID().split("-")[0]`
// kept only the first 32-bit segment (~4e9), brute-forceable in about an hour.
// (Assets use a separate content-hash id, not this.) btoa is a global in both
// Node and Workers, same as the atob the asset path already relies on.
export const newId = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(8))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// Content-addressed asset id: the lowercase hex SHA-256 of the bytes. Because
// it depends only on the content, an agent can derive `/a/:id` from the bytes
// alone — no upload round-trip — and write the URL into a surface before (or
// while) the upload lands. Identical uploads collapse to one stored blob.
// Uses Web Crypto (a global on Node ≥20 and Workers) to stay runtime-agnostic.
export async function hashAssetId(data: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view: digest wants a definite
  // ArrayBuffer, and this also avoids the SharedArrayBuffer-backed lib type.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A snippet is sugar for a single html part; this bridges the legacy
// `{ html }` shape (CLI `publish`, `POST /api/snippets`) to the parts model.
// An optional `kits` list opts the part into style/behavior bundles (kits.ts).
export const htmlPart = (html: string, kits?: unknown): HtmlPart => ({
  kind: "html",
  html,
  ...(Array.isArray(kits) && kits.length > 0
    ? { kits: kits.filter((k) => typeof k === "string") }
    : {}),
});

// The combined byte weight of a surface's parts, for size limits. image/trace
// parts are tiny (refs + inline steps) — the asset bytes they point at are
// bounded separately by MAX_ASSET_BYTES, not this surface cap.
export function partsByteLength(parts: SurfacePart[]): number {
  let n = 0;
  for (const p of parts) {
    if (p.kind === "html") n += p.html.length;
    else if (p.kind === "diff") {
      n += p.patch?.length ?? 0;
      for (const f of p.files ?? []) n += f.before.length + f.after.length;
    } else if (p.kind === "image") {
      n += p.assetId.length + (p.alt?.length ?? 0) + (p.caption?.length ?? 0);
    } else if (p.kind === "markdown") {
      n += p.markdown.length;
    } else if (p.kind === "terminal") {
      n += p.text.length + (p.title?.length ?? 0);
    } else if (p.kind === "mermaid") {
      n += p.mermaid.length;
    } else if (p.kind === "json") {
      n += JSON.stringify(p.data).length;
    } else if (p.kind === "code") {
      n +=
        p.code.length + (p.language?.length ?? 0) + (p.title?.length ?? 0) + (p.lineStart ? 4 : 0);
    } else {
      n += (p.assetId?.length ?? 0) + (p.title?.length ?? 0);
      for (const s of p.steps ?? []) {
        n += s.label.length + (s.kind?.length ?? 0) + (s.detail?.length ?? 0);
      }
    }
  }
  return n;
}

// Collect the asset ids an ordered parts list references (image/trace parts).
// Used to keep referenced assets out of eviction's first wave. Note: assets
// embedded by raw URL inside html markup are invisible here — touch-on-serve
// keeps those warm instead.
export function collectAssetIds(parts: SurfacePart[], out: Set<string>): void {
  for (const p of parts) {
    if (p.kind === "image") out.add(p.assetId);
    else if (p.kind === "trace" && p.assetId) out.add(p.assetId);
  }
}

export interface EvictionCandidate {
  id: string;
  byteLength: number;
  lastAccessedAt: string;
  referenced: boolean;
}

// Pick the assets to evict so `incomingBytes` fits under `budget`. Oldest
// (lastAccessedAt) first, but unreferenced assets go before referenced ones —
// a live embed is only evicted as a last resort, once unreferenced candidates
// are exhausted. Returns the ids to remove (possibly empty).
export function selectEvictions(
  candidates: EvictionCandidate[],
  incomingBytes: number,
  budget: number,
): string[] {
  let total = candidates.reduce((sum, c) => sum + c.byteLength, 0);
  if (total + incomingBytes <= budget) return [];
  const order = [...candidates].sort((a, b) => {
    if (a.referenced !== b.referenced) return a.referenced ? 1 : -1;
    return a.lastAccessedAt.localeCompare(b.lastAccessedAt);
  });
  const evict: string[] = [];
  for (const c of order) {
    if (total + incomingBytes <= budget) break;
    evict.push(c.id);
    total -= c.byteLength;
  }
  return evict;
}

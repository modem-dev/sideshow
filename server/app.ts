import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { decodeBase64 } from "./base64.ts";
import { EventBus, type FeedEvent } from "./events.ts";
import { kitSummaries } from "./kits.ts";
import { registerMcp } from "./mcpHttp.ts";
import {
  escapeHtml,
  renderHtmlPage,
  renderMermaidPage,
  renderSandboxedPart,
} from "./surfacePage.ts";
import { renderCode, renderDiff, renderMarkdown, renderTerminal } from "./richRender.ts";
import { DEFAULT_THEME_ID, themeById, themeOptions } from "./themes.ts";
import {
  type Asset,
  type AssetKind,
  type CodeSurface,
  type Comment,
  type CommentAnchor,
  type DiffSurface,
  htmlSurface,
  type MarkdownSurface,
  MAX_ASSET_BYTES,
  surfacesByteLength,
  type Session,
  type Store,
  type Post,
  type Surface,
  type TerminalSurface,
  type TraceStep,
} from "./types.ts";
import { validateSurfaces } from "./postSurfaces.ts";

export type { FeedEvent } from "./events.ts";

const MAX_SURFACE_BYTES = 2 * 1024 * 1024;
const MAX_WAIT_SECONDS = 300;
// Hard ceiling on any request body, applied globally. Every write endpoint
// reads its body with an unbounded `c.req.json()` (and /mcp likewise), so
// without this a single oversize POST is an out-of-memory flood — and the local
// default ships with no auth token, so those endpoints are reachable
// unauthenticated. Sized to clear the largest legitimate body — a base64 asset
// uploaded over MCP, ~4/3 of the 5 MiB asset cap — while still bounding a flood.
// The /api/assets route's own 5 MiB streaming cap is stricter and still applies.
const MAX_BODY_BYTES = 16 * 1024 * 1024;
// Bound the session trace: each step's detail is truncated and the per-session
// list rolls, so memory stays flat no matter how long the agent runs.
const MAX_TRACE_STEPS = 2000;
const MAX_STEP_DETAIL = 4000;
const MAX_STEP_LABEL = 500;
// A comment's text and a surface's title both ride the feedback channel back to
// the agent (feedbackView below), re-sent on every poll — so cap them at the
// edge to keep one oversize value from bloating the agent's context forever.
const MAX_COMMENT_TEXT = 8000;
const MAX_TITLE = 500;
// Ceiling on concurrently-held SSE + long-poll connections. Both are GETs that
// pin a connection open (the event stream indefinitely, /api/comments?wait up
// to MAX_WAIT_SECONDS); on a publicRead board they're reachable unauthenticated,
// so without a cap a flood exhausts sockets. One app instance is one workspace
// (a single Durable Object), and one workspace is one user — so legitimate
// concurrent holds are small but not tiny: each open viewer tab holds one SSE,
// and each active agent holds a long-poll (and possibly its own SSE). A
// multi-agent session with 5 agents plus a few viewer tabs can legitimately
// reach ~15. 32 clears that with headroom while still bounding a flood on a
// no-token local board — and a real flood is orders of magnitude bigger, so
// rejecting at 32 vs 16 makes no difference to flood protection, only to
// legitimate use. Configurable so deployments can tune it and tests can
// exercise the cap cheaply.
const DEFAULT_MAX_HOLD_CONNECTIONS = 32;

// Asset serving policy: only raster images are served inline; everything else
// (incl. svg, json, text, the octet-stream catch-all) is an attachment, so a
// top-level open of /a/:id can never execute an uploaded document as a live
// same-origin script. <img>/fetch ignore Content-Disposition, so embedding and
// inline trace rendering keep working regardless.
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const ATTACH_SAFE_TYPES = new Set([
  "image/svg+xml",
  "application/json",
  "application/x-ndjson",
  "text/plain",
  "text/csv",
]);

function assetServeHeaders(asset: Asset): { contentType: string; disposition: string } {
  if (INLINE_IMAGE_TYPES.has(asset.contentType)) {
    return { contentType: asset.contentType, disposition: "inline" };
  }
  const contentType = ATTACH_SAFE_TYPES.has(asset.contentType)
    ? asset.contentType
    : "application/octet-stream";
  const name = (asset.filename || asset.id).replace(/[^\w.-]/g, "_");
  return { contentType, disposition: `attachment; filename="${name}"` };
}

// Pick an AssetKind when the caller didn't specify one.
function inferAssetKind(contentType: string): AssetKind {
  return contentType.startsWith("image/") ? "image" : "file";
}

const isAssetKind = (v: unknown): v is AssetKind => v === "image" || v === "trace" || v === "file";

// base64 -> bytes, runtime-agnostic (atob is a global in Node and Workers).
// Docs and onboarding snippets are written against the local default; serve
// them with the real origin so a deployed instance shows copy-pasteable URLs.
const LOCAL_ORIGIN = "http://localhost:8228";

export type AuthenticateHook = (
  request: Request,
) => boolean | Response | Promise<boolean | Response>;

export type BasePathHook = string | ((request: Request) => string | null | undefined);
export type PublicReadMode = "session" | "full";

export interface AppOptions {
  store: Store;
  viewerHtml: string;
  guideMarkdown: string;
  setupText: string;
  agentHowtoText?: string;
  // When set (cloud deployments), this hook authorizes requests before any
  // app route runs. Return true to allow, false to use the default 401, or a
  // Response for custom denials. This is intentionally lower-level than
  // authToken so hosts can validate edge-signed assertions without teaching
  // sideshow about their session/token systems.
  authenticate?: AuthenticateHook;
  // When set (self-hosted Worker deployments), every route except /guide,
  // /setup, and /agent-howto requires it: Authorization bearer, ?key= query,
  // or the cookie it sets. Preserved for backwards compatibility.
  authToken?: string;
  // Public path prefix for deployments mounted below an origin root, e.g.
  // /u/:account in a hosted multi-tenant wrapper. The core still receives
  // stripped routes like /api/sessions and /s/:id?part=0; this prefix is only
  // used when the server/viewer generate browser-visible URLs.
  basePath?: BasePathHook;
  // When set, unauthenticated GET routes can be read without bypassing the
  // write token. "session" exposes only session-scoped reads; "full" exposes
  // every GET route.
  publicRead?: PublicReadMode;
  // Whether this deployment can render a surface as a PNG (the /s/:id.png route).
  // That route lives in the Cloudflare Worker entry and needs the Browser
  // Rendering binding; the plain Node server can't drive a headless browser, so
  // it leaves this false. Surfaced to the viewer (window.__SIDESHOW_SCREENSHOTS__)
  // so the per-surface screenshot action knows whether to enable itself.
  screenshots?: boolean;
  // Update notice: the running version and the upgrade hint that fits this
  // deployment (npm install vs redeploy). Without `version`, /api/version
  // reports nothing and the viewer shows no notice.
  version?: string;
  upgradeCommand?: string;
  // Test seam: replaces the npm-registry/GitHub lookup for the latest release.
  fetchLatestRelease?: () => Promise<LatestRelease | null>;
  // Optional live-feed tap for hosts that provide their own transport (for
  // example, a Cloudflare Durable Object WebSocket-hibernation wrapper). Receives
  // every event; transport-specific session filtering stays with the host.
  onEvent?: (event: FeedEvent) => void;
  // Max concurrently-held SSE (`/api/events`) + long-poll (`/api/comments?wait`)
  // connections before new ones are rejected with 503. Bounds a connection flood
  // on publicRead boards; defaults to DEFAULT_MAX_HOLD_CONNECTIONS.
  maxHoldConnections?: number;
}

export interface LatestRelease {
  version: string;
  notes?: string;
}

// Newer-than for plain x.y.z strings; prerelease suffixes compare as their
// base version, and garbage compares as "not newer".
function versionGt(a: string, b: string): boolean {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// Latest published version from npm, release notes from the matching GitHub
// release. Notes are garnish: if GitHub is unreachable the version alone
// still makes a usable notice.
async function fetchLatestFromRegistry(): Promise<LatestRelease | null> {
  const res = await fetch("https://registry.npmjs.org/sideshow/latest");
  if (!res.ok) return null;
  const pkg = (await res.json()) as { version?: string };
  if (typeof pkg.version !== "string") return null;
  let notes: string | undefined;
  try {
    const gh = await fetch(
      `https://api.github.com/repos/modem-dev/sideshow/releases/tags/v${pkg.version}`,
      { headers: { "user-agent": "sideshow", accept: "application/vnd.github+json" } },
    );
    if (gh.ok) {
      const rel = (await gh.json()) as { body?: string };
      if (typeof rel.body === "string") notes = rel.body;
    }
  } catch {
    // ignore — see above
  }
  return { version: pkg.version, notes };
}

const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

// html surfaces carry arbitrary markup the viewer renders via a sandboxed iframe,
// so the card list never needs their bodies — strip them to a kind marker.
// diff surfaces are structured data the viewer renders inline, so keep them whole.
const stripParts = (parts: Surface[]): Surface[] =>
  parts.map((p) => (p.kind === "html" ? { kind: "html", html: "" } : p));

const surfaceMeta = (s: Post) => ({
  id: s.id,
  sessionId: s.sessionId,
  title: s.title,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  version: s.version,
  parts: stripParts(s.surfaces),
});

// Cap inline preview fields so /api/surfaces/recent stays cheap while still
// carrying a real clipped preview. Unlike stripParts (which empties html for the
// card list), this TRUNCATES large inline payloads so a feed card can render an
// honest preview. Assets stay by-reference (assetId). When a field is clipped we
// set `truncated:true` on that part so a client can offer a "view full post"
// affordance honestly.
const PART_TEXT_CAP = 8_000; // chars; ~a screenful, enough for a clipped preview
const TRACE_STEP_PREVIEW_LIMIT = 25;
type CappedSurface = Surface & { truncated?: true };
function capText(text: string): { value: string; truncated: boolean } {
  return text.length > PART_TEXT_CAP
    ? { value: text.slice(0, PART_TEXT_CAP), truncated: true }
    : { value: text, truncated: false };
}
function capParts(parts: Surface[]): CappedSurface[] {
  return parts.map((p): CappedSurface => {
    switch (p.kind) {
      case "html": {
        const { value, truncated } = capText(p.html);
        return truncated ? { ...p, html: value, truncated: true } : p;
      }
      case "markdown": {
        const { value, truncated } = capText(p.markdown);
        return truncated ? { ...p, markdown: value, truncated: true } : p;
      }
      case "mermaid": {
        const { value, truncated } = capText(p.mermaid);
        return truncated ? { ...p, mermaid: value, truncated: true } : p;
      }
      case "code": {
        const { value, truncated } = capText(p.code);
        return truncated ? { ...p, code: value, truncated: true } : p;
      }
      case "terminal": {
        const { value, truncated } = capText(p.text);
        return truncated ? { ...p, text: value, truncated: true } : p;
      }
      case "diff": {
        let truncated = false;
        const next: CappedSurface = { ...p };
        if (p.patch !== undefined) {
          const capped = capText(p.patch);
          next.patch = capped.value;
          truncated ||= capped.truncated;
        }
        if (p.files !== undefined) {
          next.files = p.files.map((file) => {
            const before = capText(file.before);
            const after = capText(file.after);
            const filename = capText(file.filename);
            const language = file.language ? capText(file.language) : undefined;
            truncated ||= before.truncated || after.truncated || filename.truncated;
            if (language) truncated ||= language.truncated;
            return {
              ...file,
              filename: filename.value,
              before: before.value,
              after: after.value,
              ...(language && { language: language.value }),
            };
          });
        }
        return truncated ? { ...next, truncated: true } : p;
      }
      case "image": {
        const alt = p.alt ? capText(p.alt) : undefined;
        const caption = p.caption ? capText(p.caption) : undefined;
        const truncated = !!alt?.truncated || !!caption?.truncated;
        return truncated
          ? {
              ...p,
              ...(alt && { alt: alt.value }),
              ...(caption && { caption: caption.value }),
              truncated: true,
            }
          : p;
      }
      case "trace": {
        let truncated = false;
        const title = p.title ? capText(p.title) : undefined;
        if (title?.truncated) truncated = true;
        const steps = p.steps?.slice(0, TRACE_STEP_PREVIEW_LIMIT).map((step) => {
          const label = capText(step.label);
          const kind = step.kind ? capText(step.kind) : undefined;
          const detail = step.detail ? capText(step.detail) : undefined;
          const ts = step.ts ? capText(step.ts) : undefined;
          truncated ||=
            label.truncated || !!kind?.truncated || !!detail?.truncated || !!ts?.truncated;
          return {
            label: label.value,
            ...(kind && { kind: kind.value }),
            ...(detail && { detail: detail.value }),
            ...(ts && { ts: ts.value }),
          };
        });
        if ((p.steps?.length ?? 0) > TRACE_STEP_PREVIEW_LIMIT) truncated = true;
        return truncated
          ? { ...p, ...(title && { title: title.value }), ...(steps && { steps }), truncated: true }
          : p;
      }
      case "json": {
        const serialized = JSON.stringify(p.data);
        const { value, truncated } = capText(serialized);
        return truncated ? { ...p, data: value, truncated: true } : p;
      }
      default:
        return p;
    }
  });
}

function parseRecentLimit(raw: string | undefined): number {
  const parsed = Number(raw ?? "20");
  const limit = Number.isFinite(parsed) && parsed !== 0 ? Math.trunc(parsed) : 20;
  return Math.min(Math.max(limit, 1), 100);
}

function isPublicReadAllowed(path: string, mode: PublicReadMode): boolean {
  if (mode === "full") return true;
  if (path.startsWith("/session/")) return true;
  if (path.startsWith("/s/")) return true;
  if (path.startsWith("/p/")) return true;
  if (path.startsWith("/a/")) return true;
  if (path.startsWith("/api/sessions/")) return true;
  // /api/surfaces/recent is the cross-session feed source — gate it like
  // /api/sessions (NOT public on a session-scoped board), not like the
  // per-surface /api/surfaces/:id reads below.
  if (path === "/api/surfaces/recent") return false;
  if (path.startsWith("/api/surfaces/")) return true;
  if (path.startsWith("/api/posts/")) return true;
  if (path.startsWith("/api/snippets/")) return true;
  if (path === "/api/comments") return true;
  if (path === "/api/events") return true;
  if (path === "/api/theme") return true;
  if (path === "/api/version") return true;
  if (path === "/api/kits") return true;
  return false;
}

// Response to an agent's own write: it already holds the surfaces it just sent,
// so echo only the identifiers (a diff patch can be large — never send it
// back). Reads (the post list and GET /api/surfaces/:id) carry the surfaces.
const writeResult = (s: Post) => ({
  id: s.id,
  sessionId: s.sessionId,
  title: s.title,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  version: s.version,
  kinds: s.surfaces.map((p) => p.kind),
});

export interface CommentWait {
  sessionId?: string;
  surfaceId?: string;
  author?: string;
  afterSeq?: number;
  waitSeconds: number;
}

export interface Feedback {
  surfaceId: string | null;
  surfaceTitle: string | null;
  text: string;
  at: string;
  anchor?: CommentAnchor;
}

// Lean comment shape attached to agent-facing responses.
const feedbackView = (c: Comment): Feedback => ({
  surfaceId: c.postId,
  surfaceTitle: c.postTitle,
  text: c.text,
  at: c.createdAt,
  ...(c.anchor && { anchor: c.anchor }),
});

export function createApp({
  store,
  viewerHtml,
  guideMarkdown,
  setupText,
  agentHowtoText = setupText,
  authenticate,
  authToken,
  basePath,
  publicRead,
  screenshots,
  version,
  upgradeCommand,
  fetchLatestRelease,
  onEvent,
  maxHoldConnections = DEFAULT_MAX_HOLD_CONNECTIONS,
}: AppOptions) {
  const app = new Hono();
  const bus = new EventBus();
  if (onEvent) {
    bus.subscribe((event) => {
      try {
        onEvent(event);
      } catch (err) {
        console.warn("[sideshow] onEvent listener failed", err);
      }
    });
  }

  // Live count of held SSE + long-poll connections, gated by maxHoldConnections.
  // Each holder increments on entry and releases exactly once via a guarded
  // release() wired to every exit (stream abort, request abort, normal return).
  let holdConnections = 0;
  const acquireHold = (): boolean => {
    if (holdConnections >= maxHoldConnections) return false;
    holdConnections++;
    return true;
  };
  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holdConnections--;
    };
  };

  // Rendered-document cache for /s/:id rich surfaces. Rendering a markdown/code/
  // diff surface runs shiki / @pierre-diffs SSR, which is non-trivial (a big diff
  // is tens of ms + tens of KB), so memoize the finished document string. The
  // key pins everything the output depends on — post id, part index, the
  // RESOLVED version number, theme, mode — and a version's content is immutable,
  // so a hit is always correct (a post edit bumps the version → a new key).
  // Bounded + FIFO-evicted: a dropped entry costs a re-render, never
  // correctness. The DurableObject is single-instance per workspace, so this
  // in-memory cache is authoritative; a multi-instance deploy could back it with
  // KV/Cache API behind the same key without changing callers.
  const MAX_RENDER_CACHE = 512;
  const renderCache = new Map<string, string>();
  async function cachedRender(key: string, build: () => Promise<string> | string): Promise<string> {
    const hit = renderCache.get(key);
    if (hit !== undefined) {
      // refresh LRU recency
      renderCache.delete(key);
      renderCache.set(key, hit);
      return hit;
    }
    const doc = await build();
    renderCache.set(key, doc);
    while (renderCache.size > MAX_RENDER_CACHE) {
      const oldest = renderCache.keys().next().value;
      if (oldest === undefined) break;
      renderCache.delete(oldest);
    }
    return doc;
  }

  // Last-resort safety net: any handler that throws (rather than returning a
  // status) becomes a clean JSON 500 instead of leaking a stack or a bare crash.
  // Validation rejects bad input with 4xx before this, so reaching here means an
  // unexpected bug — log it so it isn't swallowed silently.
  app.onError((err, c) => {
    console.error("sideshow: unhandled error", err);
    return c.json({ error: "internal error" }, 500);
  });

  const normalizeBasePath = (value: string | null | undefined): string => {
    if (!value || value === "/") return "";
    const withLeading = value.startsWith("/") ? value : `/${value}`;
    let end = withLeading.length;
    while (end > 0 && withLeading.charCodeAt(end - 1) === 47) end--;
    return withLeading.slice(0, end);
  };
  const requestBasePath = (request: Request): string =>
    normalizeBasePath(typeof basePath === "function" ? basePath(request) : basePath);

  // Cached, fail-silent update lookup: being offline or rate-limited must
  // cost nothing but the absence of the notice. Failures are cached too, so
  // a dead network doesn't retry on every viewer load.
  let updateCache: { at: number; value: LatestRelease | null } | null = null;
  async function latestRelease(): Promise<LatestRelease | null> {
    if (updateCache && Date.now() - updateCache.at < UPDATE_CHECK_TTL_MS) return updateCache.value;
    const value = await (fetchLatestRelease ?? fetchLatestFromRegistry)().catch(() => null);
    updateCache = { at: Date.now(), value };
    return value;
  }

  // --- shared flows (used by both the REST API and the MCP endpoint) ---

  // User comments the agent has not seen yet ride along on its next write, so
  // agents hear feedback without blocking on the long-poll. The cursor also
  // advances past the agent's own comments to keep reads cheap.
  async function collectFeedback(sessionId: string): Promise<Feedback[] | undefined> {
    const session = await store.getSession(sessionId);
    if (!session) return undefined;
    const fresh = await store.listComments({ sessionId, afterSeq: session.agentSeq });
    if (fresh.length === 0) return undefined;
    await store.markAgentSeen(sessionId, fresh[fresh.length - 1].seq);
    const feedback = fresh.filter((cm) => cm.author === "user");
    return feedback.length > 0 ? feedback.map(feedbackView) : undefined;
  }

  // Maps a surface kind to its primary content field — used by content-only
  // updates (PATCH with `content`) to slot a raw string into the right field
  // while preserving extra fields (language, cols, layout, etc.).
  const CONTENT_FIELD: Record<string, string> = {
    html: "html",
    markdown: "markdown",
    mermaid: "mermaid",
    diff: "patch",
    terminal: "text",
    code: "code",
    json: "data",
  };

  // Find a surface's index by id (first match) or 0-based numeric index.
  function findSurfaceIndex(surfaces: Surface[], target: string): number {
    const byId = surfaces.findIndex((s) => s.id === target);
    if (byId >= 0) return byId;
    const idx = Number(target);
    if (Number.isInteger(idx) && idx >= 0 && idx < surfaces.length) return idx;
    return -1;
  }

  // Slot a content string into a surface's content field, preserving kind and
  // extra fields. Returns null if the kind has no content field or JSON parse
  // fails. The caller handles error reporting.
  function applyContent(surface: Surface, content: string, kits?: unknown): Surface | null {
    const field = CONTENT_FIELD[surface.kind];
    if (!field) return null;
    let value: unknown = content;
    if (surface.kind === "json") {
      try {
        value = JSON.parse(content);
      } catch {
        return null;
      }
    }
    if (surface.kind === "html") {
      return {
        ...surface,
        html: value as string,
        ...(kits !== undefined && { kits: Array.isArray(kits) ? kits : undefined }),
      };
    }
    return { ...surface, [field]: value } as Surface;
  }

  async function publishSurface(input: {
    parts: Surface[];
    title?: string;
    session?: string;
    sessionTitle?: string;
    agent?: string;
    cwd?: string;
  }): Promise<
    { surface: Post; userFeedback?: Feedback[] } | { error: string; status: 400 | 404 | 413 }
  > {
    if (input.parts.length === 0) {
      return { error: "a post needs at least one surface", status: 400 };
    }
    if (surfacesByteLength(input.parts) > MAX_SURFACE_BYTES) {
      return { error: `surface exceeds ${MAX_SURFACE_BYTES} bytes`, status: 413 };
    }
    let sessionId = input.session;
    if (sessionId && !(await store.getSession(sessionId))) {
      return { error: `session "${sessionId}" not found`, status: 404 };
    }
    if (!sessionId) {
      // sessionTitle applies only here — an existing session keeps its title,
      // which the user may have set by renaming it in the viewer.
      const session = await store.createSession({
        agent: input.agent ?? "agent",
        title: input.sessionTitle?.slice(0, MAX_TITLE),
        cwd: input.cwd,
      });
      bus.broadcast({ type: "session-created", id: session.id });
      sessionId = session.id;
    }
    const surface = await store.createPost({
      sessionId,
      surfaces: input.parts,
      title: input.title?.slice(0, MAX_TITLE),
    });
    if (!surface) return { error: "session not found", status: 404 };
    bus.broadcast({ type: "post-created", id: surface.id, sessionId, version: 1 });
    return { surface, userFeedback: await collectFeedback(sessionId) };
  }

  // Store an uploaded blob. Like publishSurface, an explicit session is
  // validated and a missing one is auto-created so an upload can precede the
  // first publish. The asset's data is dropped from the result (it's bytes).
  async function uploadAsset(input: {
    data: Uint8Array;
    contentType: string;
    filename?: string;
    kind?: AssetKind;
    session?: string;
    agent?: string;
  }): Promise<{ asset: Omit<Asset, "data"> } | { error: string; status: 400 | 404 | 413 }> {
    if (input.data.byteLength === 0) return { error: "empty upload", status: 400 };
    if (input.data.byteLength > MAX_ASSET_BYTES) {
      return { error: `asset exceeds ${MAX_ASSET_BYTES} bytes`, status: 413 };
    }
    let sessionId = input.session;
    if (sessionId && !(await store.getSession(sessionId))) {
      return { error: `session "${sessionId}" not found`, status: 404 };
    }
    if (!sessionId) {
      const session = await store.createSession({ agent: input.agent ?? "agent" });
      bus.broadcast({ type: "session-created", id: session.id });
      sessionId = session.id;
    }
    const asset = await store.putAsset({
      sessionId,
      kind: input.kind ?? inferAssetKind(input.contentType),
      contentType: input.contentType || "application/octet-stream",
      filename: input.filename,
      data: input.data,
    });
    if (!asset) return { error: "session not found", status: 404 };
    const { data: _data, ...meta } = asset;
    return { asset: meta };
  }

  async function reviseSurface(
    id: string,
    patch: { parts?: Surface[]; title?: string },
  ): Promise<
    { surface: Post; userFeedback?: Feedback[] } | { error: string; status: 400 | 404 | 413 }
  > {
    if (patch.parts) {
      if (patch.parts.length === 0) {
        return { error: "a post needs at least one surface", status: 400 };
      }
      if (surfacesByteLength(patch.parts) > MAX_SURFACE_BYTES) {
        return { error: `surface exceeds ${MAX_SURFACE_BYTES} bytes`, status: 413 };
      }
    }
    if (patch.title !== undefined) patch.title = patch.title.slice(0, MAX_TITLE);
    const surface = await store.updatePost(id, { surfaces: patch.parts, title: patch.title });
    if (!surface) return { error: "surface not found", status: 404 };
    bus.broadcast({
      type: "post-updated",
      id: surface.id,
      sessionId: surface.sessionId,
      version: surface.version,
    });
    return { surface, userFeedback: await collectFeedback(surface.sessionId) };
  }

  // --- per-surface flow functions (append / replace / remove / reorder) ---
  // Each reads the existing post, mutates the surfaces array, and writes it
  // back via reviseSurface so version/history/SSE stay consistent. Untouched
  // surfaces keep their ids (normalizeSurfaceIds preserves existing ids).

  async function appendSurface(
    id: string,
    surface: Surface,
    pos?: { before?: string; after?: string },
  ): Promise<
    { surface: Post; userFeedback?: Feedback[] } | { error: string; status: 400 | 404 | 413 }
  > {
    const existing = await store.getPost(id);
    if (!existing) return { error: "post not found", status: 404 };
    let insertAt = existing.surfaces.length;
    if (pos?.before !== undefined) {
      const i = findSurfaceIndex(existing.surfaces, pos.before);
      if (i < 0) return { error: `surface "${pos.before}" not found`, status: 404 };
      insertAt = i;
    } else if (pos?.after !== undefined) {
      const i = findSurfaceIndex(existing.surfaces, pos.after);
      if (i < 0) return { error: `surface "${pos.after}" not found`, status: 404 };
      insertAt = i + 1;
    }
    const parts = [...existing.surfaces];
    parts.splice(insertAt, 0, surface);
    return reviseSurface(id, { parts });
  }

  async function replaceSurface(
    id: string,
    target: string,
    replacement: { surface?: Surface; content?: string; kits?: unknown },
  ): Promise<
    { surface: Post; userFeedback?: Feedback[] } | { error: string; status: 400 | 404 | 413 }
  > {
    const existing = await store.getPost(id);
    if (!existing) return { error: "post not found", status: 404 };
    const idx = findSurfaceIndex(existing.surfaces, target);
    if (idx < 0) return { error: `surface "${target}" not found`, status: 404 };
    let updated: Surface;
    if (replacement.surface !== undefined) {
      // Full replacement — preserve the old surface's id so the viewer can
      // key by stable identity across edits. If kits were supplied and the
      // replacement is an html surface, apply them (matches content-only).
      updated = { ...replacement.surface, id: existing.surfaces[idx].id };
      if (replacement.kits !== undefined && updated.kind === "html") {
        updated = {
          ...updated,
          kits: Array.isArray(replacement.kits) ? replacement.kits : undefined,
        };
      }
    } else if (replacement.content !== undefined) {
      // Content-only — slot the string into the existing surface's field.
      const result = applyContent(existing.surfaces[idx], replacement.content, replacement.kits);
      if (!result) {
        return {
          error: `content update not supported for ${existing.surfaces[idx].kind} surfaces`,
          status: 400,
        };
      }
      updated = result;
    } else {
      return { error: "provide surface or content", status: 400 };
    }
    const parsed = await validateSurfaces([updated]);
    if (!parsed.ok) return { error: parsed.error, status: 400 };
    // The validator strips the id field (zod schemas don't declare it), so
    // re-apply the target's id after validation to preserve surface identity.
    const parts = [...existing.surfaces];
    parts[idx] = { ...parsed.parts[0], id: existing.surfaces[idx].id };
    return reviseSurface(id, { parts });
  }

  async function removeSurface(
    id: string,
    target: string,
  ): Promise<
    { surface: Post; userFeedback?: Feedback[] } | { error: string; status: 400 | 404 | 413 }
  > {
    const existing = await store.getPost(id);
    if (!existing) return { error: "post not found", status: 404 };
    const idx = findSurfaceIndex(existing.surfaces, target);
    if (idx < 0) return { error: `surface "${target}" not found`, status: 404 };
    if (existing.surfaces.length === 1) {
      return { error: "a post needs at least one surface", status: 400 };
    }
    const parts = existing.surfaces.filter((_, i) => i !== idx);
    return reviseSurface(id, { parts });
  }

  async function reorderSurfaces(
    id: string,
    order: (string | number)[],
  ): Promise<
    { surface: Post; userFeedback?: Feedback[] } | { error: string; status: 400 | 404 | 413 }
  > {
    const existing = await store.getPost(id);
    if (!existing) return { error: "post not found", status: 404 };
    if (order.length !== existing.surfaces.length) {
      return { error: "order array length must match surface count", status: 400 };
    }
    // Build the reordered array. Each entry is a surface id or 0-based index.
    const indexed: Surface[] = Array.from({ length: order.length });
    const used = new Set<number>();
    for (const entry of order) {
      const idx = findSurfaceIndex(existing.surfaces, String(entry));
      if (idx < 0) return { error: `surface "${entry}" not found`, status: 404 };
      if (used.has(idx)) return { error: `surface "${entry}" appears twice in order`, status: 400 };
      used.add(idx);
    }
    for (let i = 0; i < order.length; i++) {
      const idx = findSurfaceIndex(existing.surfaces, String(order[i]));
      indexed[i] = existing.surfaces[idx];
    }
    return reviseSurface(id, { parts: indexed });
  }

  function numberInRange(value: unknown, min: number, max: number): number | null {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  }

  function sanitizeCommentAnchor(raw: unknown, post: Post): CommentAnchor | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const input = raw as Record<string, unknown>;
    const kind = input.kind === "rect" || input.kind === "lineRange" ? input.kind : "point";
    let surfaceIndex = Number(input.surfaceIndex);
    if (
      !Number.isInteger(surfaceIndex) ||
      surfaceIndex < 0 ||
      surfaceIndex >= post.surfaces.length
    ) {
      const surfaceId = typeof input.surfaceId === "string" ? input.surfaceId : undefined;
      surfaceIndex = post.surfaces.findIndex((s) => s.id === surfaceId);
    }
    if (surfaceIndex < 0 || surfaceIndex >= post.surfaces.length) return undefined;
    const surface = post.surfaces[surfaceIndex];
    const base = {
      surfaceIndex,
      ...(surface.id && { surfaceId: surface.id }),
      surfaceKind: surface.kind,
      // The server pins anchors to the current stored version instead of trusting
      // the client-supplied value.
      postVersion: post.version,
    };
    if (kind === "lineRange") {
      const startLine = Number(input.startLine);
      const endLine = Number(input.endLine);
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1) {
        return undefined;
      }
      return {
        kind,
        ...base,
        startLine,
        endLine: Math.max(startLine, endLine),
        ...(typeof input.file === "string" && { file: input.file.slice(0, MAX_TITLE) }),
      };
    }
    const x = numberInRange(input.x, 0, 1);
    const y = numberInRange(input.y, 0, 1);
    if (x == null || y == null) return undefined;
    if (kind === "rect") {
      const w = numberInRange(input.w, 0, 1);
      const h = numberInRange(input.h, 0, 1);
      if (w == null || h == null) return undefined;
      return { kind, ...base, x, y, w, h };
    }
    return { kind: "point", ...base, x, y };
  }

  async function createComment(input: {
    text: string;
    surface?: string;
    author: string;
    anchor?: unknown;
  }): Promise<
    { comment: Comment; userFeedback?: Feedback[] } | { error: string; status: 400 | 404 }
  > {
    // Comments always attach to a surface — a comment with nothing to point at
    // is just a message to the agent, which is what the agent's own prompt is for.
    if (!input.surface) return { error: 'provide a "surface" id', status: 400 };
    const surface = await store.getPost(input.surface);
    if (!surface) return { error: "surface not found", status: 404 };
    const comment = await store.createComment({
      sessionId: surface.sessionId,
      postId: surface.id,
      author: input.author,
      text: input.text.trim().slice(0, MAX_COMMENT_TEXT),
      anchor: sanitizeCommentAnchor(input.anchor, surface),
    });
    if (!comment) return { error: "session not found", status: 404 };
    bus.broadcast({
      type: "comment-created",
      id: comment.id,
      sessionId: comment.sessionId,
      surfaceId: comment.postId,
      seq: comment.seq,
    });
    // agent replies are writes too — piggyback pending feedback on them, but
    // never on the user's own comments
    const userFeedback =
      input.author === "user" ? undefined : await collectFeedback(comment.sessionId);
    return { comment, userFeedback };
  }

  // Long-poll: resolves as soon as a matching comment lands, or at timeout.
  async function waitForComments(
    q: CommentWait,
  ): Promise<{ comments: Comment[]; lastSeq: number }> {
    // An author=user session wait with no explicit cursor resumes from the
    // session's agentSeq — "where the agent left off" lives server-side so the
    // CLI, both MCP transports, and piggyback share one exactly-once stream.
    let afterSeq = q.afterSeq;
    if (afterSeq === undefined && q.author === "user" && q.sessionId) {
      afterSeq = (await store.getSession(q.sessionId))?.agentSeq;
    }
    const query = { sessionId: q.sessionId, postId: q.surfaceId, afterSeq };
    const matches = (list: Comment[]) =>
      q.author ? list.filter((cm) => cm.author === q.author) : list;
    const wait = Math.min(Math.max(q.waitSeconds, 0), MAX_WAIT_SECONDS);

    let all = await store.listComments(query);
    let comments = matches(all);
    if (comments.length === 0 && wait > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, wait * 1000);
        const unsubscribe = bus.subscribe((event) => {
          if (event.type !== "comment-created") return;
          if (q.sessionId && event.sessionId !== q.sessionId) return;
          if (q.surfaceId && event.surfaceId !== q.surfaceId) return;
          done();
        });
        function done() {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
      all = await store.listComments(query);
      comments = matches(all);
    }
    // The cursor advances past every comment in the window — not just the
    // filtered ones — so the next call doesn't re-read the agent's own
    // comments. collectFeedback already does this; mirror it here.
    const lastSeq = all.length > 0 ? all[all.length - 1].seq : (afterSeq ?? 0);
    // An author=user query is the agent listening (the viewer never filters by
    // author) — what it receives here should not be re-delivered as piggyback.
    if (q.author === "user" && q.sessionId && all.length > 0) {
      await store.markAgentSeen(q.sessionId, lastSeq);
    }
    return { comments, lastSeq };
  }

  // --- auth ---

  const isAuthenticated = (c: Context): boolean => {
    if (!authToken) return true;
    if (c.req.header("authorization") === `Bearer ${authToken}`) return true;
    if (getCookie(c, "sideshow_key") === authToken) return true;
    return c.req.query("key") === authToken;
  };

  const isUnauthenticatedSessionRead = (c: Context): boolean =>
    publicRead === "session" && !isAuthenticated(c);

  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;

    if (authenticate) {
      const result = await authenticate(c.req.raw);
      if (result === true) return next();
      if (result instanceof Response) return result;
      if (path.startsWith("/api") || path === "/mcp") {
        return c.json({ error: "unauthorized" }, 401);
      }
      return c.text("unauthorized", 401);
    }

    if (!authToken) return next();
    if (path === "/guide" || path === "/setup" || path === "/agent-howto") return next();

    const key = c.req.query("key");
    if (key === authToken) {
      setCookie(c, "sideshow_key", authToken, {
        httpOnly: true,
        sameSite: "Lax",
        secure: new URL(c.req.url).protocol === "https:",
        maxAge: 60 * 60 * 24 * 90,
        path: "/",
      });
      return next();
    }
    if (publicRead && c.req.method === "GET" && isPublicReadAllowed(path, publicRead)) {
      return next();
    }
    if (isAuthenticated(c)) return next();
    if (path.startsWith("/api") || path === "/mcp") {
      return c.json({ error: "unauthorized — send Authorization: Bearer <token>" }, 401);
    }
    return c.text("unauthorized — open this page as /?key=<your token>", 401);
  });

  // Cap every request body. Runs after auth, so an unauthenticated request on a
  // token-protected workspace is rejected (401) before its body is ever read; on a
  // no-token workspace it still bounds the body. bodyLimit short-circuits on an
  // oversize Content-Length and otherwise streams-and-aborts at the cap, so a
  // chunked body (no Content-Length) can't slip past either. /api/assets is
  // exempt here because it applies its own, stricter cap (limitAssetBody below).
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "request body too large" }, 413),
  });
  app.use("*", (c, next) => (c.req.path === "/api/assets" ? next() : limitBody(c, next)));

  // The asset route's own (tighter) body cap. Keeps the asset limit and its
  // wording, and bounds the upload before it is read — bodyLimit refuses an
  // oversize Content-Length outright and aborts a chunked stream at the cap.
  const limitAssetBody = bodyLimit({
    maxSize: MAX_ASSET_BYTES,
    onError: (c) => c.json({ error: `asset exceeds ${MAX_ASSET_BYTES} bytes` }, 413),
  });

  // --- pages and docs ---

  const withOrigin = (text: string, c: { req: { url: string } }) =>
    text.replaceAll(LOCAL_ORIGIN, new URL(c.req.url).origin);

  const injectHead = (text: string, head: string) => {
    const headClose = text.lastIndexOf("</head>");
    return headClose >= 0
      ? `${text.slice(0, headClose)}${head}${text.slice(headClose)}`
      : `${head}${text}`;
  };

  const withDocumentTitle = (text: string, title: string | null | undefined) => {
    if (!title) return text;
    const escaped = escapeHtml(title);
    const titleTag = `<title>${escaped}</title>`;
    const titleStart = text.indexOf("<title>");
    if (titleStart < 0) return injectHead(text, titleTag);
    const titleEnd = text.indexOf("</title>", titleStart + "<title>".length);
    if (titleEnd < 0) return injectHead(text, titleTag);
    return `${text.slice(0, titleStart)}${titleTag}${text.slice(titleEnd + "</title>".length)}`;
  };

  const sessionDocumentTitle = (session: Session | null | undefined) => {
    if (!session) return null;
    const label = session.title || (session.agent ? `${session.agent} session` : null);
    return label ? `${label} · sideshow` : null;
  };

  const withViewerConfig = (
    text: string,
    request: Request,
    isReadonly: boolean,
    pageTitle?: string | null,
  ) => {
    const config = [
      `window.__SIDESHOW_BASE_PATH__=${JSON.stringify(requestBasePath(request))};`,
      pageTitle ? `window.__SIDESHOW_PAGE_TITLE__=${JSON.stringify(pageTitle)};` : "",
      isReadonly ? "window.__SIDESHOW_READONLY__=true;" : "",
      isReadonly && publicRead
        ? `window.__SIDESHOW_PUBLIC_READ__=${JSON.stringify(publicRead)};`
        : "",
      screenshots ? "window.__SIDESHOW_SCREENSHOTS__=true;" : "",
    ].join("");
    return injectHead(text, `<script>${config}</script>`);
  };

  const surfacePreviewHead = (surface: Post, request: Request) => {
    const origin = new URL(request.url).origin;
    const publicBasePath = requestBasePath(request);
    const canonical = `${origin}${publicBasePath}/s/${surface.id}`;
    const image = `${origin}${publicBasePath}/s/${surface.id}.png?card=1`;
    const title = escapeHtml(surface.title);
    const description = "A https://sideshow.sh surface";
    return [
      `<link rel="canonical" href="${escapeHtml(canonical)}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:title" content="${title}">`,
      `<meta property="og:description" content="${description}">`,
      `<meta property="og:url" content="${escapeHtml(canonical)}">`,
      `<meta property="og:image" content="${escapeHtml(image)}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:title" content="${title}">`,
      `<meta name="twitter:description" content="${description}">`,
      `<meta name="twitter:image" content="${escapeHtml(image)}">`,
    ].join("\n");
  };

  const configuredViewerHtml = (
    c: Context,
    opts: { surface?: Post; title?: string | null } = {},
  ) => {
    const pageTitle = opts.surface?.title ?? opts.title;
    const html = withDocumentTitle(
      withViewerConfig(
        withOrigin(viewerHtml, { req: { url: c.req.url } }),
        c.req.raw,
        !!publicRead && !isAuthenticated(c),
        pageTitle,
      ),
      pageTitle,
    );
    return opts.surface ? injectHead(html, surfacePreviewHead(opts.surface, c.req.raw)) : html;
  };
  app.get("/", (c) => c.html(configuredViewerHtml(c)));
  app.get("/session/:id", async (c) => {
    const session = await store.getSession(c.req.param("id"));
    if (isUnauthenticatedSessionRead(c) && !session) {
      return c.text("Session not found", 404);
    }
    return c.html(configuredViewerHtml(c, { title: sessionDocumentTitle(session) }));
  });
  const sessionSurfacePage = async (c: any) => {
    const session = await store.getSession(c.req.param("id"));
    if (isUnauthenticatedSessionRead(c)) {
      const surfaceId = c.req.param("surfaceId") ?? c.req.param("postId");
      const surface = await store.getPost(surfaceId ?? "");
      if (!session || !surface || surface.sessionId !== session.id) {
        return c.text("Session or surface not found", 404);
      }
    }
    return c.html(configuredViewerHtml(c, { title: sessionDocumentTitle(session) }));
  };
  app.get("/session/:id/s/:surfaceId", sessionSurfacePage);
  app.get("/session/:id/p/:postId", sessionSurfacePage); // canonical alias
  app.get("/guide", (c) => c.text(withOrigin(guideMarkdown, c)));
  app.get("/setup", (c) => c.text(withOrigin(setupText, c)));
  app.get("/agent-howto", (c) => c.text(withOrigin(agentHowtoText, c)));

  // Opt-in html kits available on this workspace (id, label, summary, classes) —
  // for discovery (`sideshow kits`); the CSS/JS payloads are server-only.
  app.get("/api/kits", (c) => c.json(kitSummaries()));

  // --- theme (one workspace-level setting) ---

  app.get("/api/theme", async (c) => {
    const id = (await store.getSetting("theme")) ?? DEFAULT_THEME_ID;
    return c.json({ id, themes: themeOptions() });
  });

  app.put("/api/theme", async (c) => {
    const body = await c.req.json().catch(() => null);
    const id = body && typeof body.id === "string" ? body.id : null;
    if (!id || !themeOptions().some((t) => t.id === id)) {
      return c.json({ error: "unknown theme id" }, 400);
    }
    await store.setSetting("theme", id);
    bus.broadcast({ type: "theme-changed", id });
    return c.json({ id });
  });

  // --- sessions ---

  app.get("/api/sessions", async (c) => {
    const [sessions, surfaces] = await Promise.all([store.listSessions(), store.listPosts()]);
    const counts = new Map<string, number>();
    for (const s of surfaces) counts.set(s.sessionId, (counts.get(s.sessionId) ?? 0) + 1);
    return c.json(sessions.map((s) => ({ ...s, surfaceCount: counts.get(s.id) ?? 0 })));
  });

  // --- recent surfaces (post-grained feed source) ---
  //
  // The N most-recently-updated posts across ALL sessions, newest first — one
  // row per post (post-grained), distinct from the session-grained GET
  // /api/sessions. This is the source a cross-session "latest posts" feed needs
  // (Org Home, a per-workspace Home): each item carries its session id/title +
  // agent for the feed card, the post's part kinds, and capped part previews.
  //
  // Previews are bounded by capParts (large inline text clipped to PART_TEXT_CAP
  // with truncated:true); images travel as plain assetId refs (served at /a/:id),
  // so the response stays cheap. Same auth as /api/sessions — see
  // isPublicReadAllowed, which intentionally does NOT expose this path on a
  // session-scoped publicRead board.
  app.get("/api/surfaces/recent", async (c) => {
    const limit = parseRecentLimit(c.req.query("limit"));
    const posts = await store.listRecentPosts(limit);
    // Resolve each post's session once (agent + session title for the feed card).
    const sessions = new Map<string, Session | null>();
    for (const p of posts) {
      if (!sessions.has(p.sessionId))
        sessions.set(p.sessionId, await store.getSession(p.sessionId));
    }
    return c.json(
      posts.map((p) => {
        const s = sessions.get(p.sessionId);
        return {
          id: p.id,
          sessionId: p.sessionId,
          sessionTitle: s?.title ?? null,
          agent: s?.agent ?? null,
          title: p.title,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          version: p.version,
          partKinds: p.surfaces.map((x) => x.kind),
          parts: capParts(p.surfaces),
        };
      }),
    );
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const session = await store.createSession({
      agent: typeof body.agent === "string" ? body.agent : "agent",
      title: typeof body.title === "string" ? body.title.slice(0, MAX_TITLE) : undefined,
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    });
    bus.broadcast({ type: "session-created", id: session.id });
    return c.json(session, 201);
  });

  app.patch("/api/sessions/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.title !== "string") {
      return c.json({ error: 'body must include "title" string' }, 400);
    }
    const session = await store.renameSession(c.req.param("id"), body.title.slice(0, MAX_TITLE));
    if (!session) return c.json({ error: "session not found" }, 404);
    bus.broadcast({ type: "session-updated", id: session.id });
    return c.json(session);
  });

  app.delete("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await store.removeSession(id))) return c.json({ error: "session not found" }, 404);
    bus.broadcast({ type: "session-deleted", id });
    return c.json({ ok: true });
  });

  const listSessionSurfaces = async (c: any) => {
    const session = await store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);
    const surfaces = await store.listPosts(session.id);
    return c.json(surfaces.map(surfaceMeta));
  };
  app.get("/api/sessions/:id/surfaces", listSessionSurfaces);
  app.get("/api/sessions/:id/posts", listSessionSurfaces); // canonical alias
  app.get("/api/sessions/:id/snippets", listSessionSurfaces); // legacy alias

  // --- session trace ---

  app.get("/api/sessions/:id/trace", async (c) => {
    const session = await store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);
    return c.json({ steps: await store.listTrace(session.id) });
  });

  // Ingest a batch of trace steps (the sync sends a windowed slice, or the tail
  // since a cursor). `reset: true` replaces the list, for a full re-sync. Steps
  // are sanitized and the per-session list is capped.
  app.post("/api/sessions/:id/trace", async (c) => {
    const session = await store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.steps)) {
      return c.json({ error: 'body must include "steps" array' }, 400);
    }
    const clean: TraceStep[] = [];
    for (const s of body.steps) {
      if (!s || typeof s.label !== "string") continue;
      clean.push({
        label: s.label.slice(0, MAX_STEP_LABEL),
        ...(typeof s.kind === "string" && { kind: s.kind.slice(0, 40) }),
        ...(typeof s.detail === "string" && { detail: s.detail.slice(0, MAX_STEP_DETAIL) }),
        ...(typeof s.ts === "string" && { ts: s.ts }),
      });
    }
    const prior = body.reset === true ? [] : await store.listTrace(session.id);
    const merged = prior.concat(clean);
    // roll the list so a long session keeps only its most recent steps
    const bounded = merged.length > MAX_TRACE_STEPS ? merged.slice(-MAX_TRACE_STEPS) : merged;
    await store.setTrace(session.id, bounded);
    bus.broadcast({ type: "trace-updated", sessionId: session.id, count: bounded.length });
    return c.json({ ok: true, added: clean.length, count: bounded.length });
  });

  // --- surfaces ---

  const getSurface = async (c: any) => {
    const surface = await store.getPost(c.req.param("id"));
    if (!surface) return c.json({ error: "surface not found" }, 404);
    return c.json(surface);
  };
  app.get("/api/surfaces/:id", getSurface);
  app.get("/api/posts/:id", getSurface); // canonical alias
  app.get("/api/snippets/:id", getSurface); // legacy alias

  // Accepts either an existing session id, or agent/cwd fields to
  // auto-create a session — so a bare `curl` one-liner works with no ceremony.
  // New clients send `surfaces`; legacy clients send `parts`. Either works.
  const publishPost = async (c: any) => {
    const body = await c.req.json().catch(() => null);
    const blocks = body?.surfaces ?? body?.parts;
    if (!body || !Array.isArray(blocks)) {
      return c.json({ error: 'body must include a "surfaces" (or legacy "parts") array' }, 400);
    }
    const parsed = await validateSurfaces(blocks);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    return publish(c, body, parsed.parts);
  };
  app.post("/api/posts", publishPost); // canonical
  app.post("/api/surfaces", publishPost);

  // Legacy html-only entry — sugar for a single html surface. An optional `kits`
  // array opts the surface into style/behavior bundles; it's validated (strict)
  // like any html surface so an unknown kit id is a clean 400.
  app.post("/api/snippets", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.html !== "string" || !body.html.trim()) {
      return c.json({ error: 'body must include non-empty "html" string' }, 400);
    }
    const parsed = await validateSurfaces([htmlSurface(body.html, body.kits)]);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    return publish(c, body, parsed.parts);
  });

  async function publish(c: any, body: any, parts: Surface[]) {
    const result = await publishSurface({
      parts,
      title: typeof body.title === "string" ? body.title : undefined,
      session: typeof body.session === "string" ? body.session : undefined,
      sessionTitle: typeof body.sessionTitle === "string" ? body.sessionTitle : undefined,
      agent: typeof body.agent === "string" ? body.agent : undefined,
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(
      {
        ...writeResult(result.surface),
        ...(result.userFeedback && { userFeedback: result.userFeedback }),
      },
      201,
    );
  }

  const revise = async (c: any) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid JSON body" }, 400);
    // posts: a `surfaces` array (legacy `parts`); snippets: an `html` string.
    // Presence — not nullishness — gates validation, so an explicit
    // `surfaces: null` is a 400 (like POST) rather than a silent title-only update.
    const hasBlocks = body.surfaces !== undefined || body.parts !== undefined;
    const blocks = body.surfaces ?? body.parts;
    let parts: Surface[] | undefined;
    if (hasBlocks) {
      if (!Array.isArray(blocks)) {
        return c.json({ error: '"surfaces" (or legacy "parts") must be an array' }, 400);
      }
      const parsed = await validateSurfaces(blocks);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      parts = parsed.parts;
    } else if (typeof body.html === "string") {
      const parsed = await validateSurfaces([htmlSurface(body.html, body.kits)]);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      parts = parsed.parts;
    }
    const result = await reviseSurface(c.req.param("id"), {
      parts,
      title: typeof body.title === "string" ? body.title : undefined,
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({
      ...writeResult(result.surface),
      ...(result.userFeedback && { userFeedback: result.userFeedback }),
    });
  };
  app.put("/api/surfaces/:id", revise);
  app.put("/api/posts/:id", revise); // canonical alias
  app.put("/api/snippets/:id", revise); // legacy alias

  // Content-only update: accepts raw content and slots it into the existing
  // surface's kind, preserving extra fields (language, cols, layout, etc.).
  // The optional `surface` field (surface id or 0-based index) targets a
  // specific surface in a multi-surface post; without it, the post must have
  // a single surface (back-compat with the original behavior).
  app.patch("/api/posts/:id", async (c: any) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid JSON body" }, 400);
    const { content, title, kits, surface } = body;
    if (content === undefined && title === undefined) {
      return c.json({ error: "provide content and/or title" }, 400);
    }
    const existing = await store.getPost(c.req.param("id"));
    if (!existing) return c.json({ error: "post not found" }, 404);
    let parts: Surface[] | undefined;
    if (content !== undefined) {
      if (typeof content !== "string") {
        return c.json({ error: '"content" must be a string' }, 400);
      }
      const targetIdx =
        surface !== undefined
          ? findSurfaceIndex(existing.surfaces, String(surface))
          : existing.surfaces.length === 1
            ? 0
            : -1;
      if (targetIdx < 0) {
        if (surface !== undefined) {
          return c.json({ error: `surface "${surface}" not found` }, 404);
        }
        return c.json(
          {
            error:
              'content update requires a "surface" target (id or index) for multi-surface posts',
          },
          400,
        );
      }
      const updated = applyContent(existing.surfaces[targetIdx], content, kits);
      if (!updated) {
        return c.json(
          {
            error: `content update not supported for ${existing.surfaces[targetIdx].kind} surfaces`,
          },
          400,
        );
      }
      const parsed = await validateSurfaces([updated]);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      parts = [...existing.surfaces];
      parts[targetIdx] = { ...parsed.parts[0], id: existing.surfaces[targetIdx].id };
    }
    const result = await reviseSurface(c.req.param("id"), {
      parts,
      title: typeof title === "string" ? title : undefined,
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({
      ...writeResult(result.surface),
      ...(result.userFeedback && { userFeedback: result.userFeedback }),
    });
  });

  // --- per-surface sub-resource routes ---

  // Append a surface to an existing post. Optional `before`/`after` (surface
  // id or index) controls insert position; default is append at the end.
  app.post("/api/posts/:id/surfaces", async (c: any) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.surface) {
      return c.json({ error: 'body must include a "surface" object' }, 400);
    }
    const parsed = await validateSurfaces([body.surface]);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const result = await appendSurface(c.req.param("id"), parsed.parts[0], {
      before: body.before,
      after: body.after,
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({
      ...writeResult(result.surface),
      ...(result.userFeedback && { userFeedback: result.userFeedback }),
    });
  });

  // Replace or content-edit a single surface. `:target` is a surface id or
  // 0-based index. Body: `{surface}` for full replacement, or `{content}` for
  // content-only (preserves kind + extra fields).
  app.patch("/api/posts/:id/surfaces/:target", async (c: any) => {
    const body = await c.req.json().catch(() => null);
    if (!body || (body.surface === undefined && body.content === undefined)) {
      return c.json({ error: 'body must include "surface" or "content"' }, 400);
    }
    let surface: Surface | undefined;
    if (body.surface !== undefined) {
      const parsed = await validateSurfaces([body.surface]);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      surface = parsed.parts[0];
    }
    const result = await replaceSurface(c.req.param("id"), c.req.param("target"), {
      surface,
      content: body.content,
      kits: body.kits,
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({
      ...writeResult(result.surface),
      ...(result.userFeedback && { userFeedback: result.userFeedback }),
    });
  });

  // Remove a single surface. `:target` is a surface id or 0-based index.
  // Rejects with 400 if it's the last surface (posts need ≥1).
  app.delete("/api/posts/:id/surfaces/:target", async (c: any) => {
    const result = await removeSurface(c.req.param("id"), c.req.param("target"));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({
      ...writeResult(result.surface),
      ...(result.userFeedback && { userFeedback: result.userFeedback }),
    });
  });

  // Reorder surfaces. Body: `{order: [id, ...]}` or `{order: [0, 2, 1]}`.
  app.patch("/api/posts/:id/surfaces", async (c: any) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.order)) {
      return c.json({ error: 'body must include an "order" array' }, 400);
    }
    const result = await reorderSurfaces(c.req.param("id"), body.order);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({
      ...writeResult(result.surface),
      ...(result.userFeedback && { userFeedback: result.userFeedback }),
    });
  });

  const remove = async (c: any) => {
    const surface = await store.getPost(c.req.param("id"));
    if (!surface) return c.json({ error: "surface not found" }, 404);
    await store.removePost(surface.id);
    bus.broadcast({ type: "post-deleted", id: surface.id, sessionId: surface.sessionId });
    return c.json({ ok: true });
  };
  app.delete("/api/surfaces/:id", remove);
  app.delete("/api/posts/:id", remove); // canonical alias
  app.delete("/api/snippets/:id", remove); // legacy alias

  // --- comments ---

  app.post("/api/comments", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: 'body must include non-empty "text" string' }, 400);
    }
    const surface = typeof body.surface === "string" ? body.surface : body.snippet;
    const result = await createComment({
      text: body.text,
      surface: typeof surface === "string" ? surface : undefined,
      author: typeof body.author === "string" ? body.author : "user",
      anchor: body.anchor,
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(
      { ...result.comment, ...(result.userFeedback && { userFeedback: result.userFeedback }) },
      201,
    );
  });

  app.delete("/api/comments/:id", async (c) => {
    const comment = await store.removeComment(c.req.param("id"));
    if (!comment) return c.json({ error: "comment not found" }, 404);
    bus.broadcast({ type: "comment-deleted", id: comment.id, sessionId: comment.sessionId });
    return c.json({ ok: true });
  });

  // The viewer's update notice: running version vs latest published release.
  app.get("/api/version", async (c) => {
    if (!version) return c.json({ current: null, latest: null, updateAvailable: false });
    const latest = await latestRelease();
    const updateAvailable = latest !== null && versionGt(latest.version, version);
    return c.json({
      current: version,
      latest: latest?.version ?? null,
      updateAvailable,
      upgradeCommand: updateAvailable ? (upgradeCommand ?? null) : null,
      notes: updateAvailable ? (latest?.notes ?? null) : null,
    });
  });

  // Long-poll friendly: ?wait=N holds the request open up to N seconds until
  // a matching comment arrives. This is how terminal agents block on feedback.
  // A wait counts against the connection cap (it pins a socket just like SSE);
  // an instant ?wait=0 read does not.
  app.get("/api/comments", async (c) => {
    const sessionId = c.req.query("session");
    const surfaceId = c.req.query("surface") ?? c.req.query("snippet");
    if (isUnauthenticatedSessionRead(c)) {
      if (!sessionId && !surfaceId) return c.json({ error: "session or surface required" }, 401);
      if (sessionId && !(await store.getSession(sessionId))) {
        return c.json({ error: "session not found" }, 404);
      }
      if (surfaceId) {
        const surface = await store.getPost(surfaceId);
        if (!surface || (sessionId && surface.sessionId !== sessionId)) {
          return c.json({ error: "surface not found" }, 404);
        }
      }
    }
    const waitSeconds = Number(c.req.query("wait") ?? 0) || 0;
    if (waitSeconds > 0) {
      if (!acquireHold()) return c.json({ error: "too many concurrent connections" }, 503);
      const release = makeRelease();
      // If the client disconnects mid-wait, release the slot promptly.
      c.req.raw.signal.addEventListener("abort", release, { once: true });
      try {
        const result = await waitForComments({
          sessionId,
          surfaceId,
          author: c.req.query("author"),
          afterSeq: c.req.query("after") ? Number(c.req.query("after")) : undefined,
          waitSeconds,
        });
        return c.json(result);
      } finally {
        release();
      }
    }
    const result = await waitForComments({
      sessionId,
      surfaceId,
      author: c.req.query("author"),
      afterSeq: c.req.query("after") ? Number(c.req.query("after")) : undefined,
      waitSeconds: 0,
    });
    return c.json(result);
  });

  // --- rendering ---

  // Serves one surface of a post as a themed, sandboxed document. The viewer
  // points an iframe here for every surface kind that becomes HTML — html surfaces
  // (author markup) and the rich kinds (markdown/code/diff/terminal rendered
  // server-side; mermaid as a self-rendering CDN doc). Image/trace/json surfaces
  // are data the viewer renders natively (text nodes / <img> / JSX), so they
  // never reach here.
  const renderSurfacePage = async (c: any) => {
    const surface = await store.getPost(c.req.param("id"));
    if (!surface) return c.text("Post not found", 404);
    const partParam = c.req.query("surface") ?? c.req.query("part");
    if (partParam == null) return c.html(configuredViewerHtml(c, { surface }));

    const ver = c.req.query("ver");
    let title = surface.title;
    let parts = surface.surfaces;
    let version = surface.version;
    if (ver && Number(ver) !== surface.version) {
      const old = surface.history.find((h) => h.version === Number(ver));
      if (!old) return c.text(`Version ${ver} not available`, 404);
      title = old.title;
      parts = old.surfaces;
      version = old.version;
    }
    const idx = Number(partParam ?? 0);
    const part = parts[idx];
    // Only the kinds that become HTML are served here. Image/trace/json render
    // natively in the viewer and must not be reachable as a document.
    const SANDBOXED = ["html", "markdown", "code", "diff", "terminal", "mermaid"];
    if (!part || !SANDBOXED.includes(part.kind)) {
      return c.text("No renderable surface at that index", 404);
    }
    c.header("X-Content-Type-Options", "nosniff");
    // Sandbox the document however it is loaded. The viewer embeds this in an
    // iframe whose `sandbox="allow-scripts"` attribute gives it an opaque origin,
    // but the document is served from the workspace's own origin — so a TOP-LEVEL
    // load (a user opening /s/:id in a new tab, an agent-shared link) would
    // otherwise run the agent's script in the workspace origin, where it could reach
    // same-origin storage or window.open('/') the real viewer. A `sandbox` CSP
    // can only be set as a response header (not the meta tag the page carries),
    // and it forces the same opaque-origin sandbox on a direct navigation:
    // allow-scripts so the bridge still runs, but no allow-same-origin, so agent
    // code can never touch the workspace origin. Mirrors the iframe's sandbox flags.
    c.header("Content-Security-Policy", "sandbox allow-scripts");
    // Theme: an explicit ?theme= (the viewer keys iframe srcs by it so a switch
    // reloads the frame) wins; otherwise the persisted workspace theme; else default.
    const themeId = c.req.query("theme") ?? (await store.getSetting("theme")) ?? DEFAULT_THEME_ID;
    const theme = themeById(themeId);
    // Scheme: the viewer passes the light/dark mode it resolved so the iframe is
    // pinned to it rather than re-deriving from the OS (which can diverge from
    // the chrome across the frame boundary). Absent/invalid → follow the OS.
    const modeParam = c.req.query("mode");
    const mode = modeParam === "light" || modeParam === "dark" ? modeParam : undefined;
    const origin = new URL(c.req.url).origin;

    // Cache the finished document. The key pins everything the output depends
    // on; the resolved `version` makes it immutable, so a hit is always correct.
    // Versioned + themed requests (what the viewer always sends) are immutable,
    // so allow long-lived shared caching; an unpinned direct load is not.
    const cacheKey = `${surface.id}:${idx}:${version}:${themeId}:${mode ?? "os"}`;
    const immutable = c.req.query("ver") != null && c.req.query("theme") != null;
    if (immutable) c.header("Cache-Control", "public, max-age=31536000, immutable");
    else c.header("Cache-Control", "private, no-cache");

    const doc = await cachedRender(cacheKey, async () => {
      if (part.kind === "html") {
        return renderHtmlPage({ title, html: part.html, origin, theme, mode, kits: part.kits });
      }
      if (part.kind === "mermaid") {
        return renderMermaidPage({ mermaid: part.mermaid, origin, theme, mode });
      }
      const rendered =
        part.kind === "markdown"
          ? await renderMarkdown(part as MarkdownSurface, { theme: themeId, mode })
          : part.kind === "code"
            ? await renderCode(part as CodeSurface, { theme: themeId, mode })
            : part.kind === "terminal"
              ? renderTerminal(part as TerminalSurface)
              : await renderDiff(part as DiffSurface, { theme: themeId, mode }).catch((e) => ({
                  body: `<div class="rich-error">Couldn’t render diff — ${escapeHtml(
                    e instanceof Error ? e.message : "render error",
                  )}</div>`,
                  css: `.rich-error{color:var(--danger);font:13px/1.5 ui-monospace,monospace;padding:8px 12px;}`,
                }));
      return renderSandboxedPart({ body: rendered.body, css: rendered.css, origin, theme, mode });
    });
    return c.html(doc);
  };
  app.get("/s/:id", renderSurfacePage);
  app.get("/p/:id", renderSurfacePage); // canonical alias

  // --- assets (agent-uploaded images, traces, files) ---

  // Accepts raw bytes (the asset's own Content-Type, metadata via query) or a
  // JSON envelope { data: base64, contentType, ... } — so curl --data-binary
  // and a JSON client both work, and MCP can ride base64. The body is read once
  // and only treated as an envelope when it is application/json carrying a
  // base64 `data` string; a raw JSON asset (no top-level `data`) stays raw.
  app.post("/api/assets", limitAssetBody, async (c) => {
    const mime = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    // limitAssetBody has already bounded the body to MAX_ASSET_BYTES, so this
    // read is safe. The post-decode cap in uploadAsset still applies (a base64
    // envelope decodes to ~3/4), enforcing the true asset limit on the bytes.
    const buf = new Uint8Array(await c.req.arrayBuffer());
    let envelope: any = null;
    if (mime === "application/json") {
      try {
        const j = JSON.parse(new TextDecoder().decode(buf));
        if (j && typeof j.data === "string") envelope = j;
      } catch {
        // not an envelope — fall through to the raw path
      }
    }
    const kindQ = c.req.query("kind");
    let body;
    try {
      body = envelope
        ? {
            data: decodeBase64(envelope.data),
            contentType:
              typeof envelope.contentType === "string"
                ? envelope.contentType
                : "application/octet-stream",
            filename: typeof envelope.filename === "string" ? envelope.filename : undefined,
            kind: isAssetKind(envelope.kind) ? envelope.kind : undefined,
            session: typeof envelope.session === "string" ? envelope.session : undefined,
            agent: typeof envelope.agent === "string" ? envelope.agent : undefined,
          }
        : {
            data: buf,
            contentType: mime || "application/octet-stream",
            filename: c.req.query("filename"),
            kind: isAssetKind(kindQ) ? kindQ : undefined,
            session: c.req.query("session"),
            agent: c.req.query("agent"),
          };
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "invalid upload" }, 400);
    }
    const result = await uploadAsset(body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    const origin = new URL(c.req.url).origin;
    const publicBasePath = requestBasePath(c.req.raw);
    const assetPath = encodeURIComponent(result.asset.id);
    return c.json({ ...result.asset, url: `${origin}${publicBasePath}/a/${assetPath}` }, 201);
  });

  app.get("/a/:id", async (c) => {
    const id = c.req.param("id");
    let asset = await store.getAsset(id);
    // Optimistic uploads: an agent can derive an asset's URL from its content
    // hash and publish a surface referencing it before (or while) the bytes are
    // uploaded. Rather than 404 in that window, briefly wait for the bytes —
    // but only when a live surface actually points at this id, so unknown ids
    // still fail fast.
    if (!asset && (await store.isAssetReferenced(id))) {
      for (let i = 0; i < 20 && !asset; i++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        asset = await store.getAsset(id);
      }
    }
    if (!asset) return c.text("Asset not found", 404);
    await store.touchAsset(asset.id);
    const { contentType, disposition } = assetServeHeaders(asset);
    c.header("Content-Type", contentType);
    c.header("Content-Disposition", disposition);
    c.header("X-Content-Type-Options", "nosniff");
    // Short revalidating cache (not immutable) so touch-on-serve keeps firing
    // and the LRU clock reflects real views; asset ids are unique anyway.
    c.header("Cache-Control", "private, max-age=60");
    return c.body(asset.data as unknown as ArrayBuffer);
  });

  // --- live feed ---

  app.get("/api/events", async (c) => {
    const sessionId = c.req.query("session");
    if (isUnauthenticatedSessionRead(c)) {
      if (!sessionId) return c.json({ error: "session required" }, 401);
      if (!(await store.getSession(sessionId))) return c.json({ error: "session not found" }, 404);
    }
    if (!acquireHold()) return c.json({ error: "too many concurrent connections" }, 503);
    const release = makeRelease();
    // Safety net: if the client disconnects before the stream callback opens,
    // the request abort still releases the slot. close() below is guarded so a
    // later abort firing release again is a no-op.
    c.req.raw.signal.addEventListener("abort", release, { once: true });
    const eventSessionId = (event: Parameters<Parameters<EventBus["subscribe"]>[0]>[0]) => {
      if ("sessionId" in event) return event.sessionId;
      if (event.type.startsWith("session-")) return event.id;
      return undefined;
    };
    return streamSSE(c, async (stream) => {
      const queue: Parameters<Parameters<EventBus["subscribe"]>[0]>[0][] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = bus.subscribe((event) => {
        if (sessionId && eventSessionId(event) !== sessionId) return;
        queue.push(event);
        wake?.();
      });
      let open = true;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        open = false;
        unsubscribe();
        wake?.();
        release();
      };
      stream.onAbort(close);
      c.req.raw.signal.addEventListener("abort", close, { once: true });
      try {
        await stream.writeSSE({ event: "hello", data: "{}" });
        while (open) {
          while (queue.length > 0) {
            await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
          }
          let pingTimer: ReturnType<typeof setTimeout> | null = null;
          await Promise.race([
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
            new Promise<void>((resolve) => {
              pingTimer = setTimeout(resolve, 15000);
            }),
          ]);
          wake = null;
          if (pingTimer) clearTimeout(pingTimer);
          if (open && queue.length === 0) {
            await stream.writeSSE({ event: "ping", data: "{}" });
          }
        }
      } finally {
        close();
      }
    });
  });

  // --- MCP over streamable HTTP (works locally and deployed) ---

  registerMcp(app, {
    store,
    basePath: requestBasePath,
    publishSurface,
    reviseSurface,
    appendSurface,
    replaceSurface,
    removeSurface,
    reorderSurfaces,
    createComment,
    waitForComments,
    uploadAsset,
    guide: guideMarkdown,
  });

  return app;
}

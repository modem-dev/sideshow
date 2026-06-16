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
// markup (rendered sandboxed in an iframe); a `diff` part is structured data
// (a patch) rendered by the trusted viewer. A snippet is just a surface with
// one html part; a diagram-with-its-diff is `[html, diff]` in one card.
export type SurfacePartKind = "html" | "diff";

export interface HtmlPart {
  kind: "html";
  html: string;
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

export type SurfacePart = HtmlPart | DiffPart;

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

  listSurfaces(sessionId?: string): Promise<Surface[]>;
  getSurface(id: string): Promise<Surface | null>;
  createSurface(input: CreateSurfaceInput): Promise<Surface | null>;
  updateSurface(id: string, patch: UpdateSurfaceInput): Promise<Surface | null>;
  removeSurface(id: string): Promise<boolean>;

  listComments(query: CommentQuery): Promise<Comment[]>;
  createComment(input: CreateCommentInput): Promise<Comment | null>;
}

export const HISTORY_LIMIT = 20;

export const newId = () => crypto.randomUUID().split("-")[0];

// A snippet is sugar for a single html part; this bridges the legacy
// `{ html }` shape (CLI `publish`, `POST /api/snippets`) to the parts model.
export const htmlPart = (html: string): HtmlPart => ({ kind: "html", html });

// The combined byte weight of a surface's parts, for size limits.
export function partsByteLength(parts: SurfacePart[]): number {
  let n = 0;
  for (const p of parts) {
    if (p.kind === "html") n += p.html.length;
    else {
      n += p.patch?.length ?? 0;
      for (const f of p.files ?? []) n += f.before.length + f.after.length;
    }
  }
  return n;
}

// First html part — the back-compat view used by the legacy snippet routes.
export const firstHtml = (parts: SurfacePart[]): string => {
  const p = parts.find((p): p is HtmlPart => p.kind === "html");
  return p ? p.html : "";
};

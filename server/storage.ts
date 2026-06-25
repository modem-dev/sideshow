import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type Asset,
  type WorkspaceSnapshot,
  collectAssetIds,
  type Comment,
  type CommentQuery,
  type CreateAssetInput,
  type CreateCommentInput,
  type CreateSessionInput,
  type CreatePostInput,
  hashAssetId,
  HISTORY_LIMIT,
  htmlSurface,
  MAX_WORKSPACE_ASSET_BYTES,
  newId,
  selectEvictions,
  type Session,
  stripNul,
  stripNulStep,
  type Store,
  type Post,
  type PostVersion,
  type Surface,
  type TraceStep,
  type UpdatePostInput,
} from "./types.ts";

export type * from "./types.ts";

// On disk an asset's bytes are base64 (JSON can't hold a Uint8Array); in memory
// it is the live Asset with raw bytes.
type StoredAsset = Omit<Asset, "data"> & { data: string };

const clone = <T>(value: T): T => structuredClone(value);
const cloneOrNull = <T>(value: T | null | undefined): T | null =>
  value == null ? null : clone(value);

interface FileShape {
  sessions: Session[];
  surfaces: Post[];
  comments: Comment[];
  assets: StoredAsset[];
  trace: Record<string, TraceStep[]>;
  lastSeq: number;
  settings: Record<string, string>;
}

// Pre-0.5.0 workspaces stored `snippets` (a single `html` field) and comments
// keyed by `snippetId`. Read those shapes and lift them into the surfaces model.
interface LegacySnippetVersion {
  version: number;
  title: string;
  html: string;
  at: string;
}
interface LegacySnippet {
  id: string;
  sessionId: string;
  title: string;
  html: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  history: LegacySnippetVersion[];
}
interface LegacyShape extends Omit<Partial<FileShape>, "surfaces"> {
  surfaces?: LegacyPost[];
  snippets?: LegacySnippet[];
}

function liftSnippet(s: LegacySnippet): Post {
  return {
    id: s.id,
    sessionId: s.sessionId,
    title: s.title,
    surfaces: [htmlSurface(s.html)],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    version: s.version,
    history: (s.history ?? []).map((h) => ({
      version: h.version,
      title: h.title,
      surfaces: [htmlSurface(h.html)],
      at: h.at,
    })),
  };
}

type LegacyComment = Comment & {
  snippetId?: string | null;
  snippetTitle?: string | null;
  // 0.5.x workspaces keyed comments by `surfaceId`/`surfaceTitle`.
  surfaceId?: string | null;
  surfaceTitle?: string | null;
};

function liftComment(c: LegacyComment): Comment {
  return {
    id: c.id,
    seq: c.seq,
    sessionId: c.sessionId,
    postId: c.postId ?? c.surfaceId ?? c.snippetId ?? null,
    postTitle: c.postTitle ?? c.surfaceTitle ?? c.snippetTitle ?? null,
    author: c.author,
    text: c.text,
    createdAt: c.createdAt,
  };
}

// 0.5.x workspaces stored each post's blocks under a `parts` field (and
// `history[].parts`). Map those to the `surfaces` field so old files still load.
type LegacyPostVersion = PostVersion & { parts?: Surface[] };
type LegacyPost = Omit<Post, "surfaces" | "history"> & {
  surfaces?: Surface[];
  parts?: Surface[];
  history?: LegacyPostVersion[];
};

function liftPost(s: LegacyPost): Post {
  return {
    id: s.id,
    sessionId: s.sessionId,
    title: s.title,
    surfaces: s.surfaces ?? s.parts ?? [],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    version: s.version,
    history: (s.history ?? []).map((h) => ({
      version: h.version,
      title: h.title,
      surfaces: h.surfaces ?? h.parts ?? [],
      at: h.at,
    })),
  };
}

export class JsonFileStore implements Store {
  private sessions = new Map<string, Session>();
  private surfaces = new Map<string, Post>();
  private comments: Comment[] = [];
  private assets = new Map<string, Asset>();
  private trace = new Map<string, TraceStep[]>();
  private lastSeq = 0;
  private settings = new Map<string, string>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async load() {
    if (this.loaded) return;
    this.loadPromise ??= this.loadFromDisk().catch((err) => {
      this.loadPromise = null;
      throw err;
    });
    await this.loadPromise;
  }

  private async loadFromDisk() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as LegacyShape;
      // agentSeq arrived after 0.2.0 — default it for data files written before
      for (const s of data.sessions ?? []) {
        this.sessions.set(s.id, { ...s, agentSeq: s.agentSeq ?? 0 });
      }
      // Prefer the surfaces array; fall back to lifting legacy snippets.
      if (data.surfaces) {
        for (const s of data.surfaces) this.surfaces.set(s.id, liftPost(s));
      } else if (data.snippets) {
        for (const s of data.snippets) this.surfaces.set(s.id, liftSnippet(s));
      }
      this.comments = (data.comments ?? []).map(liftComment);
      for (const a of data.assets ?? []) {
        this.assets.set(a.id, {
          ...a,
          data: new Uint8Array(Buffer.from(a.data, "base64")),
          lastAccessedAt: a.lastAccessedAt ?? a.createdAt,
        });
      }
      for (const [sid, steps] of Object.entries(data.trace ?? {})) this.trace.set(sid, steps);
      this.lastSeq = data.lastSeq ?? 0;
      for (const [k, v] of Object.entries(data.settings ?? {})) this.settings.set(k, v);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
    this.loaded = true;
  }

  private persist() {
    const data = JSON.stringify(
      {
        sessions: [...this.sessions.values()],
        surfaces: [...this.surfaces.values()],
        comments: this.comments,
        assets: [...this.assets.values()].map((a) => ({
          ...a,
          data: Buffer.from(a.data).toString("base64"),
        })),
        trace: Object.fromEntries(this.trace),
        lastSeq: this.lastSeq,
        settings: Object.fromEntries(this.settings),
      } satisfies FileShape,
      null,
      2,
    );
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, data, "utf8");
      await rename(tmp, this.filePath);
    });
    return this.writeQueue;
  }

  // Snapshot the whole workspace for a one-time backend migration (→ SqlStore.
  // importBoard). Returns live references — fine for a read-once-then-import
  // migration, which never mutates the store afterward.
  async exportBoard(): Promise<WorkspaceSnapshot> {
    await this.load();
    return {
      sessions: [...this.sessions.values()],
      surfaces: [...this.surfaces.values()],
      comments: this.comments,
      assets: [...this.assets.values()],
      traces: [...this.trace.entries()].map(([sessionId, steps]) => ({ sessionId, steps })),
      settings: [...this.settings.entries()].map(([key, value]) => ({ key, value })),
    };
  }

  // --- sessions ---

  async listSessions() {
    await this.load();
    return [...this.sessions.values()]
      .map(clone)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  async getSession(id: string) {
    await this.load();
    return cloneOrNull(this.sessions.get(id));
  }

  async createSession(input: CreateSessionInput) {
    await this.load();
    const now = new Date().toISOString();
    const session: Session = {
      id: newId(),
      agent: stripNul(input.agent).trim() || "agent",
      title: stripNul(input.title)?.trim() || null,
      cwd: stripNul(input.cwd ?? null),
      createdAt: now,
      lastActiveAt: now,
      agentSeq: 0,
    };
    this.sessions.set(session.id, session);
    await this.persist();
    return clone(session);
  }

  async renameSession(id: string, title: string) {
    await this.load();
    const session = this.sessions.get(id);
    if (!session) return null;
    session.title = stripNul(title).trim() || null;
    await this.persist();
    return clone(session);
  }

  async removeSession(id: string) {
    await this.load();
    if (!this.sessions.delete(id)) return false;
    for (const [sid, surface] of this.surfaces) {
      if (surface.sessionId === id) this.surfaces.delete(sid);
    }
    this.comments = this.comments.filter((c) => c.sessionId !== id);
    this.trace.delete(id);
    // Assets are content-addressed and may be referenced across sessions, so a
    // session only takes its OWN assets down with it, and only those no live
    // surface still points at (referencedAssetIds is computed after the above
    // deletes, so it reflects survivors only).
    const referenced = this.referencedAssetIds();
    for (const [aid, asset] of this.assets) {
      if (asset.sessionId === id && !referenced.has(aid)) this.assets.delete(aid);
    }
    await this.persist();
    return true;
  }

  private touch(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) session.lastActiveAt = new Date().toISOString();
  }

  async markAgentSeen(sessionId: string, seq: number) {
    await this.load();
    const session = this.sessions.get(sessionId);
    if (!session || seq <= session.agentSeq) return;
    session.agentSeq = seq;
    await this.persist();
  }

  // --- settings ---

  async getSetting(key: string) {
    await this.load();
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string) {
    await this.load();
    this.settings.set(stripNul(key), stripNul(value));
    await this.persist();
  }

  // --- surfaces ---

  async listPosts(sessionId?: string) {
    await this.load();
    const all = [...this.surfaces.values()].filter(
      (s) => sessionId === undefined || s.sessionId === sessionId,
    );
    return all.map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getPost(id: string) {
    await this.load();
    return cloneOrNull(this.surfaces.get(id));
  }

  async createPost(input: CreatePostInput) {
    await this.load();
    if (!this.sessions.has(input.sessionId)) return null;
    const now = new Date().toISOString();
    const surface: Post = {
      id: newId(),
      sessionId: input.sessionId,
      title: stripNul(input.title)?.trim() || "Untitled",
      surfaces: clone(input.surfaces),
      createdAt: now,
      updatedAt: now,
      version: 1,
      history: [],
    };
    this.surfaces.set(surface.id, surface);
    this.touch(input.sessionId);
    await this.persist();
    return clone(surface);
  }

  async updatePost(id: string, patch: UpdatePostInput) {
    await this.load();
    const surface = this.surfaces.get(id);
    if (!surface) return null;
    surface.history.push({
      version: surface.version,
      title: surface.title,
      surfaces: clone(surface.surfaces),
      at: surface.updatedAt,
    });
    if (surface.history.length > HISTORY_LIMIT) surface.history.shift();
    if (patch.title !== undefined) surface.title = stripNul(patch.title).trim() || surface.title;
    if (patch.surfaces !== undefined) surface.surfaces = clone(patch.surfaces);
    surface.version += 1;
    surface.updatedAt = new Date().toISOString();
    this.touch(surface.sessionId);
    await this.persist();
    return clone(surface);
  }

  async removePost(id: string) {
    await this.load();
    const surface = this.surfaces.get(id);
    if (!surface) return false;
    this.surfaces.delete(id);
    this.comments = this.comments.filter((c) => c.postId !== id);
    await this.persist();
    return true;
  }

  // --- comments ---

  async listComments(query: CommentQuery) {
    await this.load();
    return this.comments
      .filter(
        (c) =>
          (query.sessionId === undefined || c.sessionId === query.sessionId) &&
          (query.postId === undefined || c.postId === query.postId) &&
          (query.afterSeq === undefined || c.seq > query.afterSeq),
      )
      .map(clone);
  }

  async createComment(input: CreateCommentInput) {
    await this.load();
    if (!this.sessions.has(input.sessionId)) return null;
    const surface = input.postId ? this.surfaces.get(input.postId) : null;
    const comment: Comment = {
      id: newId(),
      seq: ++this.lastSeq,
      sessionId: input.sessionId,
      postId: surface?.id ?? null,
      postTitle: surface?.title ?? null,
      author: stripNul(input.author).trim() || "user",
      text: stripNul(input.text),
      createdAt: new Date().toISOString(),
    };
    this.comments.push(comment);
    this.touch(input.sessionId);
    await this.persist();
    return clone(comment);
  }

  // --- trace ---

  async listTrace(sessionId: string) {
    await this.load();
    return clone(this.trace.get(sessionId) ?? []);
  }

  async setTrace(sessionId: string, steps: TraceStep[]) {
    await this.load();
    if (steps.length === 0) this.trace.delete(sessionId);
    else this.trace.set(sessionId, steps.map(stripNulStep));
    await this.persist();
  }

  // --- assets ---

  private referencedAssetIds(): Set<string> {
    const out = new Set<string>();
    for (const s of this.surfaces.values()) {
      collectAssetIds(s.surfaces, out);
      for (const h of s.history) collectAssetIds(h.surfaces, out);
    }
    return out;
  }

  async putAsset(input: CreateAssetInput) {
    await this.load();
    if (!this.sessions.has(input.sessionId)) return null;
    // Content-addressed: identical bytes dedupe to the existing blob (idempotent
    // upload), keeping its original session and createdAt; we just warm it.
    const id = await hashAssetId(input.data);
    const existing = this.assets.get(id);
    if (existing) {
      existing.lastAccessedAt = new Date().toISOString();
      this.touch(input.sessionId);
      await this.persist();
      return clone(existing);
    }
    const referenced = this.referencedAssetIds();
    const candidates = [...this.assets.values()].map((a) => ({
      id: a.id,
      byteLength: a.byteLength,
      lastAccessedAt: a.lastAccessedAt,
      referenced: referenced.has(a.id),
    }));
    for (const id of selectEvictions(
      candidates,
      input.data.byteLength,
      MAX_WORKSPACE_ASSET_BYTES,
    )) {
      this.assets.delete(id);
    }
    const now = new Date().toISOString();
    const asset: Asset = {
      id,
      sessionId: input.sessionId,
      kind: input.kind,
      contentType: stripNul(input.contentType),
      byteLength: input.data.byteLength,
      filename: stripNul(input.filename ?? null),
      data: new Uint8Array(input.data),
      createdAt: now,
      lastAccessedAt: now,
    };
    this.assets.set(asset.id, asset);
    this.touch(input.sessionId);
    await this.persist();
    return clone(asset);
  }

  async getAsset(id: string) {
    await this.load();
    return cloneOrNull(this.assets.get(id));
  }

  async touchAsset(id: string) {
    await this.load();
    const asset = this.assets.get(id);
    if (!asset) return;
    asset.lastAccessedAt = new Date().toISOString();
    await this.persist();
  }

  async listAssets(sessionId: string) {
    await this.load();
    return [...this.assets.values()].filter((a) => a.sessionId === sessionId).map(clone);
  }

  async removeAsset(id: string) {
    await this.load();
    if (!this.assets.delete(id)) return false;
    await this.persist();
    return true;
  }

  async isAssetReferenced(id: string) {
    await this.load();
    return this.referencedAssetIds().has(id);
  }
}

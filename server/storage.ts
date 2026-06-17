import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type Asset,
  collectAssetIds,
  type Comment,
  type CommentQuery,
  type CreateAssetInput,
  type CreateCommentInput,
  type CreateSessionInput,
  type CreateSurfaceInput,
  hashAssetId,
  HISTORY_LIMIT,
  htmlPart,
  MAX_BOARD_ASSET_BYTES,
  newId,
  selectEvictions,
  type Session,
  type Store,
  type Surface,
  type UpdateSurfaceInput,
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
  surfaces: Surface[];
  comments: Comment[];
  assets: StoredAsset[];
  lastSeq: number;
}

// Pre-0.5.0 boards stored `snippets` (a single `html` field) and comments
// keyed by `snippetId`. Read those shapes and lift them into the parts model.
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
interface LegacyShape extends Partial<FileShape> {
  snippets?: LegacySnippet[];
}

function liftSnippet(s: LegacySnippet): Surface {
  return {
    id: s.id,
    sessionId: s.sessionId,
    title: s.title,
    parts: [htmlPart(s.html)],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    version: s.version,
    history: (s.history ?? []).map((h) => ({
      version: h.version,
      title: h.title,
      parts: [htmlPart(h.html)],
      at: h.at,
    })),
  };
}

type LegacyComment = Comment & { snippetId?: string | null; snippetTitle?: string | null };

function liftComment(c: LegacyComment): Comment {
  return {
    id: c.id,
    seq: c.seq,
    sessionId: c.sessionId,
    surfaceId: c.surfaceId ?? c.snippetId ?? null,
    surfaceTitle: c.surfaceTitle ?? c.snippetTitle ?? null,
    author: c.author,
    text: c.text,
    createdAt: c.createdAt,
  };
}

export class JsonFileStore implements Store {
  private sessions = new Map<string, Session>();
  private surfaces = new Map<string, Surface>();
  private comments: Comment[] = [];
  private assets = new Map<string, Asset>();
  private lastSeq = 0;
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
        for (const s of data.surfaces) this.surfaces.set(s.id, s);
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
      this.lastSeq = data.lastSeq ?? 0;
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
        lastSeq: this.lastSeq,
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
      agent: input.agent.trim() || "agent",
      title: input.title?.trim() || null,
      cwd: input.cwd ?? null,
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
    session.title = title.trim() || null;
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

  // --- surfaces ---

  async listSurfaces(sessionId?: string) {
    await this.load();
    const all = [...this.surfaces.values()].filter(
      (s) => sessionId === undefined || s.sessionId === sessionId,
    );
    return all.map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getSurface(id: string) {
    await this.load();
    return cloneOrNull(this.surfaces.get(id));
  }

  async createSurface(input: CreateSurfaceInput) {
    await this.load();
    if (!this.sessions.has(input.sessionId)) return null;
    const now = new Date().toISOString();
    const surface: Surface = {
      id: newId(),
      sessionId: input.sessionId,
      title: input.title?.trim() || "Untitled",
      parts: clone(input.parts),
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

  async updateSurface(id: string, patch: UpdateSurfaceInput) {
    await this.load();
    const surface = this.surfaces.get(id);
    if (!surface) return null;
    surface.history.push({
      version: surface.version,
      title: surface.title,
      parts: clone(surface.parts),
      at: surface.updatedAt,
    });
    if (surface.history.length > HISTORY_LIMIT) surface.history.shift();
    if (patch.title !== undefined) surface.title = patch.title.trim() || surface.title;
    if (patch.parts !== undefined) surface.parts = clone(patch.parts);
    surface.version += 1;
    surface.updatedAt = new Date().toISOString();
    this.touch(surface.sessionId);
    await this.persist();
    return clone(surface);
  }

  async removeSurface(id: string) {
    await this.load();
    const surface = this.surfaces.get(id);
    if (!surface) return false;
    this.surfaces.delete(id);
    this.comments = this.comments.filter((c) => c.surfaceId !== id);
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
          (query.surfaceId === undefined || c.surfaceId === query.surfaceId) &&
          (query.afterSeq === undefined || c.seq > query.afterSeq),
      )
      .map(clone);
  }

  async createComment(input: CreateCommentInput) {
    await this.load();
    if (!this.sessions.has(input.sessionId)) return null;
    const surface = input.surfaceId ? this.surfaces.get(input.surfaceId) : null;
    const comment: Comment = {
      id: newId(),
      seq: ++this.lastSeq,
      sessionId: input.sessionId,
      surfaceId: surface?.id ?? null,
      surfaceTitle: surface?.title ?? null,
      author: input.author.trim() || "user",
      text: input.text,
      createdAt: new Date().toISOString(),
    };
    this.comments.push(comment);
    this.touch(input.sessionId);
    await this.persist();
    return clone(comment);
  }

  // --- assets ---

  private referencedAssetIds(): Set<string> {
    const out = new Set<string>();
    for (const s of this.surfaces.values()) {
      collectAssetIds(s.parts, out);
      for (const h of s.history) collectAssetIds(h.parts, out);
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
    for (const id of selectEvictions(candidates, input.data.byteLength, MAX_BOARD_ASSET_BYTES)) {
      this.assets.delete(id);
    }
    const now = new Date().toISOString();
    const asset: Asset = {
      id,
      sessionId: input.sessionId,
      kind: input.kind,
      contentType: input.contentType,
      byteLength: input.data.byteLength,
      filename: input.filename ?? null,
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

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type Comment,
  type CommentQuery,
  type CreateCommentInput,
  type CreateSessionInput,
  type CreateSurfaceInput,
  HISTORY_LIMIT,
  htmlPart,
  newId,
  type Session,
  type Store,
  type Surface,
  type UpdateSurfaceInput,
} from "./types.ts";

export type * from "./types.ts";

interface FileShape {
  sessions: Session[];
  surfaces: Surface[];
  comments: Comment[];
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
  private lastSeq = 0;
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
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
      this.lastSeq = data.lastSeq ?? 0;
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  private persist() {
    const data = JSON.stringify(
      {
        sessions: [...this.sessions.values()],
        surfaces: [...this.surfaces.values()],
        comments: this.comments,
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
    return [...this.sessions.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  async getSession(id: string) {
    await this.load();
    return this.sessions.get(id) ?? null;
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
    return session;
  }

  async renameSession(id: string, title: string) {
    await this.load();
    const session = this.sessions.get(id);
    if (!session) return null;
    session.title = title.trim() || null;
    await this.persist();
    return session;
  }

  async removeSession(id: string) {
    await this.load();
    if (!this.sessions.delete(id)) return false;
    for (const [sid, surface] of this.surfaces) {
      if (surface.sessionId === id) this.surfaces.delete(sid);
    }
    this.comments = this.comments.filter((c) => c.sessionId !== id);
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
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getSurface(id: string) {
    await this.load();
    return this.surfaces.get(id) ?? null;
  }

  async createSurface(input: CreateSurfaceInput) {
    await this.load();
    if (!this.sessions.has(input.sessionId)) return null;
    const now = new Date().toISOString();
    const surface: Surface = {
      id: newId(),
      sessionId: input.sessionId,
      title: input.title?.trim() || "Untitled",
      parts: input.parts,
      createdAt: now,
      updatedAt: now,
      version: 1,
      history: [],
    };
    this.surfaces.set(surface.id, surface);
    this.touch(input.sessionId);
    await this.persist();
    return surface;
  }

  async updateSurface(id: string, patch: UpdateSurfaceInput) {
    await this.load();
    const surface = this.surfaces.get(id);
    if (!surface) return null;
    surface.history.push({
      version: surface.version,
      title: surface.title,
      parts: surface.parts,
      at: surface.updatedAt,
    });
    if (surface.history.length > HISTORY_LIMIT) surface.history.shift();
    if (patch.title !== undefined) surface.title = patch.title.trim() || surface.title;
    if (patch.parts !== undefined) surface.parts = patch.parts;
    surface.version += 1;
    surface.updatedAt = new Date().toISOString();
    this.touch(surface.sessionId);
    await this.persist();
    return surface;
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
    return this.comments.filter(
      (c) =>
        (query.sessionId === undefined || c.sessionId === query.sessionId) &&
        (query.surfaceId === undefined || c.surfaceId === query.surfaceId) &&
        (query.afterSeq === undefined || c.seq > query.afterSeq),
    );
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
    return comment;
  }
}

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
  type SurfacePart,
  type SurfaceVersion,
  type UpdateSurfaceInput,
} from "../server/types.ts";

// Store implementation on Durable Object SQLite. One board = one DO = one
// database, so plain SQL with no tenant columns.
export class SqlStore implements Store {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, title TEXT, cwd TEXT,
        createdAt TEXT NOT NULL, lastActiveAt TEXT NOT NULL,
        agentSeq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS surfaces (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, title TEXT NOT NULL,
        parts TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        version INTEGER NOT NULL, history TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
        sessionId TEXT NOT NULL, surfaceId TEXT, surfaceTitle TEXT,
        author TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL
      );
    `);
    // Boards created before agentSeq existed need the column added; SQLite
    // has no ADD COLUMN IF NOT EXISTS, so probe and patch.
    const sessionCols = this.sql.exec("SELECT name FROM pragma_table_info('sessions')").toArray();
    if (!sessionCols.some((c) => c.name === "agentSeq")) {
      this.sql.exec("ALTER TABLE sessions ADD COLUMN agentSeq INTEGER NOT NULL DEFAULT 0");
    }
    this.migrateToSurfaces();
  }

  // Pre-0.5.0 boards stored a `snippets` table and `comments.snippetId`. Lift
  // them into the parts model in place — deployed DOs can never be reset.
  private migrateToSurfaces() {
    const commentCols = this.sql
      .exec("SELECT name FROM pragma_table_info('comments')")
      .toArray()
      .map((c) => c.name as string);
    if (commentCols.includes("snippetId") && !commentCols.includes("surfaceId")) {
      this.sql.exec("ALTER TABLE comments RENAME COLUMN snippetId TO surfaceId");
    }
    if (commentCols.includes("snippetTitle") && !commentCols.includes("surfaceTitle")) {
      this.sql.exec("ALTER TABLE comments RENAME COLUMN snippetTitle TO surfaceTitle");
    }

    const tables = this.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((t) => t.name as string);
    if (!tables.includes("snippets")) return;
    for (const r of this.sql.exec("SELECT * FROM snippets").toArray()) {
      const legacyHistory = JSON.parse((r.history as string) ?? "[]") as Array<{
        version: number;
        title: string;
        html: string;
        at: string;
      }>;
      const history: SurfaceVersion[] = legacyHistory.map((h) => ({
        version: h.version,
        title: h.title,
        parts: [htmlPart(h.html)],
        at: h.at,
      }));
      this.sql.exec(
        "INSERT OR IGNORE INTO surfaces (id, sessionId, title, parts, createdAt, updatedAt, version, history) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        r.id as string,
        r.sessionId as string,
        r.title as string,
        JSON.stringify([htmlPart(r.html as string)]),
        r.createdAt as string,
        r.updatedAt as string,
        r.version as number,
        JSON.stringify(history),
      );
    }
    this.sql.exec("DROP TABLE snippets");
  }

  private rowToSession(r: Record<string, SqlStorageValue>): Session {
    return {
      id: r.id as string,
      agent: r.agent as string,
      title: (r.title as string) ?? null,
      cwd: (r.cwd as string) ?? null,
      createdAt: r.createdAt as string,
      lastActiveAt: r.lastActiveAt as string,
      agentSeq: (r.agentSeq as number) ?? 0,
    };
  }

  private rowToSurface(r: Record<string, SqlStorageValue>): Surface {
    return {
      id: r.id as string,
      sessionId: r.sessionId as string,
      title: r.title as string,
      parts: JSON.parse(r.parts as string) as SurfacePart[],
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
      version: r.version as number,
      history: JSON.parse(r.history as string) as SurfaceVersion[],
    };
  }

  private rowToComment(r: Record<string, SqlStorageValue>): Comment {
    return {
      id: r.id as string,
      seq: r.seq as number,
      sessionId: r.sessionId as string,
      surfaceId: (r.surfaceId as string) ?? null,
      surfaceTitle: (r.surfaceTitle as string) ?? null,
      author: r.author as string,
      text: r.text as string,
      createdAt: r.createdAt as string,
    };
  }

  // --- sessions ---

  async listSessions() {
    return this.sql
      .exec("SELECT * FROM sessions ORDER BY lastActiveAt DESC")
      .toArray()
      .map((r) => this.rowToSession(r));
  }

  async getSession(id: string) {
    const rows = this.sql.exec("SELECT * FROM sessions WHERE id = ?", id).toArray();
    return rows.length > 0 ? this.rowToSession(rows[0]) : null;
  }

  async createSession(input: CreateSessionInput) {
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
    this.sql.exec(
      "INSERT INTO sessions (id, agent, title, cwd, createdAt, lastActiveAt, agentSeq) VALUES (?, ?, ?, ?, ?, ?, 0)",
      session.id,
      session.agent,
      session.title,
      session.cwd,
      session.createdAt,
      session.lastActiveAt,
    );
    return session;
  }

  async renameSession(id: string, title: string) {
    const session = await this.getSession(id);
    if (!session) return null;
    session.title = title.trim() || null;
    this.sql.exec("UPDATE sessions SET title = ? WHERE id = ?", session.title, id);
    return session;
  }

  async removeSession(id: string) {
    if (!(await this.getSession(id))) return false;
    this.sql.exec("DELETE FROM comments WHERE sessionId = ?", id);
    this.sql.exec("DELETE FROM surfaces WHERE sessionId = ?", id);
    this.sql.exec("DELETE FROM sessions WHERE id = ?", id);
    return true;
  }

  private touch(sessionId: string) {
    this.sql.exec(
      "UPDATE sessions SET lastActiveAt = ? WHERE id = ?",
      new Date().toISOString(),
      sessionId,
    );
  }

  async markAgentSeen(sessionId: string, seq: number) {
    this.sql.exec(
      "UPDATE sessions SET agentSeq = ? WHERE id = ? AND agentSeq < ?",
      seq,
      sessionId,
      seq,
    );
  }

  // --- surfaces ---

  async listSurfaces(sessionId?: string) {
    const rows =
      sessionId === undefined
        ? this.sql.exec("SELECT * FROM surfaces ORDER BY createdAt ASC").toArray()
        : this.sql
            .exec("SELECT * FROM surfaces WHERE sessionId = ? ORDER BY createdAt ASC", sessionId)
            .toArray();
    return rows.map((r) => this.rowToSurface(r));
  }

  async getSurface(id: string) {
    const rows = this.sql.exec("SELECT * FROM surfaces WHERE id = ?", id).toArray();
    return rows.length > 0 ? this.rowToSurface(rows[0]) : null;
  }

  async createSurface(input: CreateSurfaceInput) {
    if (!(await this.getSession(input.sessionId))) return null;
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
    this.sql.exec(
      "INSERT INTO surfaces (id, sessionId, title, parts, createdAt, updatedAt, version, history) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      surface.id,
      surface.sessionId,
      surface.title,
      JSON.stringify(surface.parts),
      surface.createdAt,
      surface.updatedAt,
      surface.version,
      "[]",
    );
    this.touch(input.sessionId);
    return surface;
  }

  async updateSurface(id: string, patch: UpdateSurfaceInput) {
    const surface = await this.getSurface(id);
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
    this.sql.exec(
      "UPDATE surfaces SET title = ?, parts = ?, updatedAt = ?, version = ?, history = ? WHERE id = ?",
      surface.title,
      JSON.stringify(surface.parts),
      surface.updatedAt,
      surface.version,
      JSON.stringify(surface.history),
      id,
    );
    this.touch(surface.sessionId);
    return surface;
  }

  async removeSurface(id: string) {
    if (!(await this.getSurface(id))) return false;
    this.sql.exec("DELETE FROM comments WHERE surfaceId = ?", id);
    this.sql.exec("DELETE FROM surfaces WHERE id = ?", id);
    return true;
  }

  // --- comments ---

  async listComments(query: CommentQuery) {
    const clauses: string[] = [];
    const params: SqlStorageValue[] = [];
    if (query.sessionId !== undefined) {
      clauses.push("sessionId = ?");
      params.push(query.sessionId);
    }
    if (query.surfaceId !== undefined) {
      clauses.push("surfaceId = ?");
      params.push(query.surfaceId);
    }
    if (query.afterSeq !== undefined) {
      clauses.push("seq > ?");
      params.push(query.afterSeq);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.sql
      .exec(`SELECT * FROM comments ${where} ORDER BY seq ASC`, ...params)
      .toArray()
      .map((r) => this.rowToComment(r));
  }

  async createComment(input: CreateCommentInput) {
    if (!(await this.getSession(input.sessionId))) return null;
    const surface = input.surfaceId ? await this.getSurface(input.surfaceId) : null;
    const id = newId();
    const createdAt = new Date().toISOString();
    const author = input.author.trim() || "user";
    this.sql.exec(
      "INSERT INTO comments (id, sessionId, surfaceId, surfaceTitle, author, text, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      input.sessionId,
      surface?.id ?? null,
      surface?.title ?? null,
      author,
      input.text,
      createdAt,
    );
    const seq = this.sql.exec("SELECT last_insert_rowid() AS seq").one().seq as number;
    this.touch(input.sessionId);
    return {
      id,
      seq,
      sessionId: input.sessionId,
      surfaceId: surface?.id ?? null,
      surfaceTitle: surface?.title ?? null,
      author,
      text: input.text,
      createdAt,
    };
  }
}

import {
  type Comment,
  type CommentQuery,
  type CreateCommentInput,
  type CreateSessionInput,
  type CreateSnippetInput,
  HISTORY_LIMIT,
  newId,
  type Session,
  type Snippet,
  type Store,
  type UpdateSnippetInput,
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
      CREATE TABLE IF NOT EXISTS snippets (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, title TEXT NOT NULL,
        html TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        version INTEGER NOT NULL, history TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
        sessionId TEXT NOT NULL, snippetId TEXT, snippetTitle TEXT,
        author TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL
      );
    `);
    // Boards created before agentSeq existed need the column added; SQLite
    // has no ADD COLUMN IF NOT EXISTS, so probe and patch.
    const cols = this.sql.exec("SELECT name FROM pragma_table_info('sessions')").toArray();
    if (!cols.some((c) => c.name === "agentSeq")) {
      this.sql.exec("ALTER TABLE sessions ADD COLUMN agentSeq INTEGER NOT NULL DEFAULT 0");
    }
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

  private rowToSnippet(r: Record<string, SqlStorageValue>): Snippet {
    return {
      id: r.id as string,
      sessionId: r.sessionId as string,
      title: r.title as string,
      html: r.html as string,
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
      version: r.version as number,
      history: JSON.parse(r.history as string),
    };
  }

  private rowToComment(r: Record<string, SqlStorageValue>): Comment {
    return {
      id: r.id as string,
      seq: r.seq as number,
      sessionId: r.sessionId as string,
      snippetId: (r.snippetId as string) ?? null,
      snippetTitle: (r.snippetTitle as string) ?? null,
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
    this.sql.exec("DELETE FROM snippets WHERE sessionId = ?", id);
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

  // --- snippets ---

  async listSnippets(sessionId?: string) {
    const rows =
      sessionId === undefined
        ? this.sql.exec("SELECT * FROM snippets ORDER BY createdAt ASC").toArray()
        : this.sql
            .exec("SELECT * FROM snippets WHERE sessionId = ? ORDER BY createdAt ASC", sessionId)
            .toArray();
    return rows.map((r) => this.rowToSnippet(r));
  }

  async getSnippet(id: string) {
    const rows = this.sql.exec("SELECT * FROM snippets WHERE id = ?", id).toArray();
    return rows.length > 0 ? this.rowToSnippet(rows[0]) : null;
  }

  async createSnippet(input: CreateSnippetInput) {
    if (!(await this.getSession(input.sessionId))) return null;
    const now = new Date().toISOString();
    const snippet: Snippet = {
      id: newId(),
      sessionId: input.sessionId,
      title: input.title?.trim() || "Untitled",
      html: input.html,
      createdAt: now,
      updatedAt: now,
      version: 1,
      history: [],
    };
    this.sql.exec(
      "INSERT INTO snippets (id, sessionId, title, html, createdAt, updatedAt, version, history) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      snippet.id,
      snippet.sessionId,
      snippet.title,
      snippet.html,
      snippet.createdAt,
      snippet.updatedAt,
      snippet.version,
      "[]",
    );
    this.touch(input.sessionId);
    return snippet;
  }

  async updateSnippet(id: string, patch: UpdateSnippetInput) {
    const snippet = await this.getSnippet(id);
    if (!snippet) return null;
    snippet.history.push({
      version: snippet.version,
      title: snippet.title,
      html: snippet.html,
      at: snippet.updatedAt,
    });
    if (snippet.history.length > HISTORY_LIMIT) snippet.history.shift();
    if (patch.title !== undefined) snippet.title = patch.title.trim() || snippet.title;
    if (patch.html !== undefined) snippet.html = patch.html;
    snippet.version += 1;
    snippet.updatedAt = new Date().toISOString();
    this.sql.exec(
      "UPDATE snippets SET title = ?, html = ?, updatedAt = ?, version = ?, history = ? WHERE id = ?",
      snippet.title,
      snippet.html,
      snippet.updatedAt,
      snippet.version,
      JSON.stringify(snippet.history),
      id,
    );
    this.touch(snippet.sessionId);
    return snippet;
  }

  async removeSnippet(id: string) {
    if (!(await this.getSnippet(id))) return false;
    this.sql.exec("DELETE FROM comments WHERE snippetId = ?", id);
    this.sql.exec("DELETE FROM snippets WHERE id = ?", id);
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
    if (query.snippetId !== undefined) {
      clauses.push("snippetId = ?");
      params.push(query.snippetId);
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
    const snippet = input.snippetId ? await this.getSnippet(input.snippetId) : null;
    const id = newId();
    const createdAt = new Date().toISOString();
    const author = input.author.trim() || "user";
    this.sql.exec(
      "INSERT INTO comments (id, sessionId, snippetId, snippetTitle, author, text, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      input.sessionId,
      snippet?.id ?? null,
      snippet?.title ?? null,
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
      snippetId: snippet?.id ?? null,
      snippetTitle: snippet?.title ?? null,
      author,
      text: input.text,
      createdAt,
    };
  }
}

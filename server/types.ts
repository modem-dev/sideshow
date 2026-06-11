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

export interface SnippetVersion {
  version: number;
  title: string;
  html: string;
  at: string;
}

export interface Snippet {
  id: string;
  sessionId: string;
  title: string;
  html: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  history: SnippetVersion[];
}

export interface Comment {
  id: string;
  seq: number;
  sessionId: string;
  snippetId: string | null;
  snippetTitle: string | null;
  author: string;
  text: string;
  createdAt: string;
}

export interface CreateSessionInput {
  agent: string;
  title?: string;
  cwd?: string;
}

export interface CreateSnippetInput {
  sessionId: string;
  title?: string;
  html: string;
}

export interface UpdateSnippetInput {
  title?: string;
  html?: string;
}

export interface CreateCommentInput {
  sessionId: string;
  snippetId?: string;
  author: string;
  text: string;
}

export interface CommentQuery {
  sessionId?: string;
  snippetId?: string;
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

  listSnippets(sessionId?: string): Promise<Snippet[]>;
  getSnippet(id: string): Promise<Snippet | null>;
  createSnippet(input: CreateSnippetInput): Promise<Snippet | null>;
  updateSnippet(id: string, patch: UpdateSnippetInput): Promise<Snippet | null>;
  removeSnippet(id: string): Promise<boolean>;

  listComments(query: CommentQuery): Promise<Comment[]>;
  createComment(input: CreateCommentInput): Promise<Comment | null>;
}

export const HISTORY_LIMIT = 20;

export const newId = () => crypto.randomUUID().split("-")[0];

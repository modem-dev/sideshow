import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { EventBus } from "./events.ts";
import { registerMcp } from "./mcpHttp.ts";
import { renderSnippetPage } from "./snippetPage.ts";
import type { Comment, Snippet, Store } from "./types.ts";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_WAIT_SECONDS = 300;
// Docs and onboarding snippets are written against the local default; serve
// them with the real origin so a deployed instance shows copy-pasteable URLs.
const LOCAL_ORIGIN = "http://localhost:4242";

export interface AppOptions {
  store: Store;
  viewerHtml: string;
  guideMarkdown: string;
  setupText: string;
  // When set (cloud deployments), every route except /guide and /setup
  // requires it: Authorization bearer, ?key= query, or the cookie it sets.
  authToken?: string;
}

const snippetMeta = (s: Snippet) => ({
  id: s.id,
  sessionId: s.sessionId,
  title: s.title,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  version: s.version,
});

export interface CommentWait {
  sessionId?: string;
  snippetId?: string;
  author?: string;
  afterSeq?: number;
  waitSeconds: number;
}

// Lean comment shape attached to agent-facing responses.
export const feedbackView = (c: Comment) => ({
  snippetId: c.snippetId,
  snippetTitle: c.snippetTitle,
  text: c.text,
  at: c.createdAt,
});

export type Feedback = ReturnType<typeof feedbackView>;

export function createApp({ store, viewerHtml, guideMarkdown, setupText, authToken }: AppOptions) {
  const app = new Hono();
  const bus = new EventBus();

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

  async function publishSnippet(input: {
    html: string;
    title?: string;
    session?: string;
    agent?: string;
    cwd?: string;
  }): Promise<
    { snippet: Snippet; userFeedback?: Feedback[] } | { error: string; status: 404 | 413 }
  > {
    if (input.html.length > MAX_HTML_BYTES) {
      return { error: `html exceeds ${MAX_HTML_BYTES} bytes`, status: 413 };
    }
    let sessionId = input.session;
    if (sessionId && !(await store.getSession(sessionId))) {
      return { error: `session "${sessionId}" not found`, status: 404 };
    }
    if (!sessionId) {
      const session = await store.createSession({ agent: input.agent ?? "agent", cwd: input.cwd });
      bus.broadcast({ type: "session-created", id: session.id });
      sessionId = session.id;
    }
    const snippet = await store.createSnippet({
      sessionId,
      html: input.html,
      title: input.title,
    });
    if (!snippet) return { error: "session not found", status: 404 };
    bus.broadcast({ type: "snippet-created", id: snippet.id, sessionId, version: 1 });
    return { snippet, userFeedback: await collectFeedback(sessionId) };
  }

  async function reviseSnippet(
    id: string,
    patch: { html?: string; title?: string },
  ): Promise<
    { snippet: Snippet; userFeedback?: Feedback[] } | { error: string; status: 404 | 413 }
  > {
    if (typeof patch.html === "string" && patch.html.length > MAX_HTML_BYTES) {
      return { error: `html exceeds ${MAX_HTML_BYTES} bytes`, status: 413 };
    }
    const snippet = await store.updateSnippet(id, patch);
    if (!snippet) return { error: "snippet not found", status: 404 };
    bus.broadcast({
      type: "snippet-updated",
      id: snippet.id,
      sessionId: snippet.sessionId,
      version: snippet.version,
    });
    return { snippet, userFeedback: await collectFeedback(snippet.sessionId) };
  }

  async function createComment(input: {
    text: string;
    snippet?: string;
    session?: string;
    author: string;
  }): Promise<
    { comment: Comment; userFeedback?: Feedback[] } | { error: string; status: 400 | 404 }
  > {
    let sessionId = input.session;
    if (input.snippet) {
      const snippet = await store.getSnippet(input.snippet);
      if (!snippet) return { error: "snippet not found", status: 404 };
      sessionId = snippet.sessionId;
    }
    if (!sessionId) return { error: 'provide "snippet" or "session" id', status: 400 };
    const comment = await store.createComment({
      sessionId,
      snippetId: input.snippet,
      author: input.author,
      text: input.text.trim(),
    });
    if (!comment) return { error: "session not found", status: 404 };
    bus.broadcast({
      type: "comment-created",
      id: comment.id,
      sessionId: comment.sessionId,
      snippetId: comment.snippetId,
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
    const query = { sessionId: q.sessionId, snippetId: q.snippetId, afterSeq: q.afterSeq };
    const matches = (list: Comment[]) =>
      q.author ? list.filter((cm) => cm.author === q.author) : list;
    const wait = Math.min(Math.max(q.waitSeconds, 0), MAX_WAIT_SECONDS);

    let comments = matches(await store.listComments(query));
    if (comments.length === 0 && wait > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, wait * 1000);
        const unsubscribe = bus.subscribe((event) => {
          if (event.type !== "comment-created") return;
          if (q.sessionId && event.sessionId !== q.sessionId) return;
          if (q.snippetId && event.snippetId !== q.snippetId) return;
          done();
        });
        function done() {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
      comments = matches(await store.listComments(query));
    }
    const lastSeq = comments.length > 0 ? comments[comments.length - 1].seq : (q.afterSeq ?? 0);
    // An author=user query is the agent listening (the viewer never filters by
    // author) — what it receives here should not be re-delivered as piggyback.
    if (q.author === "user" && q.sessionId && comments.length > 0) {
      await store.markAgentSeen(q.sessionId, lastSeq);
    }
    return { comments, lastSeq };
  }

  // --- auth ---

  app.use("*", async (c, next) => {
    if (!authToken) return next();
    const path = new URL(c.req.url).pathname;
    if (path === "/guide" || path === "/setup") return next();

    const bearer = c.req.header("authorization");
    if (bearer === `Bearer ${authToken}`) return next();
    if (getCookie(c, "sideshow_key") === authToken) return next();
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
    if (path.startsWith("/api") || path === "/mcp") {
      return c.json({ error: "unauthorized — send Authorization: Bearer <token>" }, 401);
    }
    return c.text("unauthorized — open this page as /?key=<your token>", 401);
  });

  // --- pages and docs ---

  const withOrigin = (text: string, c: { req: { url: string } }) =>
    text.replaceAll(LOCAL_ORIGIN, new URL(c.req.url).origin);

  app.get("/", (c) => c.html(withOrigin(viewerHtml, c)));
  app.get("/guide", (c) => c.text(withOrigin(guideMarkdown, c)));
  app.get("/setup", (c) => c.text(withOrigin(setupText, c)));

  // --- sessions ---

  app.get("/api/sessions", async (c) => {
    const [sessions, snippets] = await Promise.all([store.listSessions(), store.listSnippets()]);
    const counts = new Map<string, number>();
    for (const s of snippets) counts.set(s.sessionId, (counts.get(s.sessionId) ?? 0) + 1);
    return c.json(sessions.map((s) => ({ ...s, snippetCount: counts.get(s.id) ?? 0 })));
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const session = await store.createSession({
      agent: typeof body.agent === "string" ? body.agent : "agent",
      title: typeof body.title === "string" ? body.title : undefined,
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
    const session = await store.renameSession(c.req.param("id"), body.title);
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

  app.get("/api/sessions/:id/snippets", async (c) => {
    const session = await store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);
    const snippets = await store.listSnippets(session.id);
    return c.json(snippets.map(snippetMeta));
  });

  // --- snippets ---

  app.get("/api/snippets/:id", async (c) => {
    const snippet = await store.getSnippet(c.req.param("id"));
    if (!snippet) return c.json({ error: "snippet not found" }, 404);
    return c.json(snippet);
  });

  // Accepts either an existing session id, or agent/cwd fields to
  // auto-create a session — so a bare `curl` one-liner works with no ceremony.
  app.post("/api/snippets", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.html !== "string" || !body.html.trim()) {
      return c.json({ error: 'body must include non-empty "html" string' }, 400);
    }
    const result = await publishSnippet({
      html: body.html,
      title: typeof body.title === "string" ? body.title : undefined,
      session: typeof body.session === "string" ? body.session : undefined,
      agent: typeof body.agent === "string" ? body.agent : undefined,
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(
      {
        ...snippetMeta(result.snippet),
        ...(result.userFeedback && { userFeedback: result.userFeedback }),
      },
      201,
    );
  });

  app.put("/api/snippets/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid JSON body" }, 400);
    const result = await reviseSnippet(c.req.param("id"), {
      html: typeof body.html === "string" ? body.html : undefined,
      title: typeof body.title === "string" ? body.title : undefined,
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({
      ...snippetMeta(result.snippet),
      ...(result.userFeedback && { userFeedback: result.userFeedback }),
    });
  });

  app.delete("/api/snippets/:id", async (c) => {
    const snippet = await store.getSnippet(c.req.param("id"));
    if (!snippet) return c.json({ error: "snippet not found" }, 404);
    await store.removeSnippet(snippet.id);
    bus.broadcast({ type: "snippet-deleted", id: snippet.id, sessionId: snippet.sessionId });
    return c.json({ ok: true });
  });

  // --- comments ---

  app.post("/api/comments", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: 'body must include non-empty "text" string' }, 400);
    }
    const result = await createComment({
      text: body.text,
      snippet: typeof body.snippet === "string" ? body.snippet : undefined,
      session: typeof body.session === "string" ? body.session : undefined,
      author: typeof body.author === "string" ? body.author : "user",
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(
      { ...result.comment, ...(result.userFeedback && { userFeedback: result.userFeedback }) },
      201,
    );
  });

  // Long-poll friendly: ?wait=N holds the request open up to N seconds until
  // a matching comment arrives. This is how terminal agents block on feedback.
  app.get("/api/comments", async (c) => {
    const result = await waitForComments({
      sessionId: c.req.query("session"),
      snippetId: c.req.query("snippet"),
      author: c.req.query("author"),
      afterSeq: c.req.query("after") ? Number(c.req.query("after")) : undefined,
      waitSeconds: Number(c.req.query("wait") ?? 0) || 0,
    });
    return c.json(result);
  });

  // --- rendering ---

  app.get("/s/:id", async (c) => {
    const snippet = await store.getSnippet(c.req.param("id"));
    if (!snippet) return c.text("Snippet not found", 404);
    const ver = c.req.query("ver");
    let doc = snippet;
    if (ver && Number(ver) !== snippet.version) {
      const old = snippet.history.find((h) => h.version === Number(ver));
      if (!old) return c.text(`Version ${ver} not available`, 404);
      doc = { ...snippet, title: old.title, html: old.html };
    }
    c.header("X-Content-Type-Options", "nosniff");
    return c.html(renderSnippetPage(doc));
  });

  // --- live feed ---

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: Parameters<Parameters<EventBus["subscribe"]>[0]>[0][] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = bus.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      let open = true;
      stream.onAbort(() => {
        open = false;
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: "{}" });
      while (open) {
        while (queue.length > 0) {
          await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
        }
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          stream.sleep(15000),
        ]);
        wake = null;
        if (open && queue.length === 0) {
          await stream.writeSSE({ event: "ping", data: "{}" });
        }
      }
    }),
  );

  // --- MCP over streamable HTTP (works locally and deployed) ---

  registerMcp(app, {
    store,
    publishSnippet,
    reviseSnippet,
    createComment,
    waitForComments,
    guide: guideMarkdown,
  });

  return app;
}

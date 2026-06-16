import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { EventBus } from "./events.ts";
import { registerMcp } from "./mcpHttp.ts";
import { renderHtmlPage } from "./surfacePage.ts";
import {
  type Comment,
  htmlPart,
  partsByteLength,
  type Store,
  type Surface,
  type SurfacePart,
} from "./types.ts";

const MAX_SURFACE_BYTES = 2 * 1024 * 1024;
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
  // Update notice: the running version and the upgrade hint that fits this
  // deployment (npm install vs redeploy). Without `version`, /api/version
  // reports nothing and the viewer shows no notice.
  version?: string;
  upgradeCommand?: string;
  // Test seam: replaces the npm-registry/GitHub lookup for the latest release.
  fetchLatestRelease?: () => Promise<LatestRelease | null>;
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

// html parts carry arbitrary markup the viewer renders via a sandboxed iframe,
// so the card list never needs their bodies — strip them to a kind marker.
// diff parts are structured data the viewer renders inline, so keep them whole.
const stripParts = (parts: SurfacePart[]): SurfacePart[] =>
  parts.map((p) => (p.kind === "html" ? { kind: "html", html: "" } : p));

const surfaceMeta = (s: Surface) => ({
  id: s.id,
  sessionId: s.sessionId,
  title: s.title,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  version: s.version,
  parts: stripParts(s.parts),
});

// Response to an agent's own write: it already holds the parts it just sent,
// so echo only the identifiers (a diff patch can be large — never send it
// back). Reads (`surfaceMeta`, GET /api/surfaces/:id) still carry parts.
const writeResult = (s: Surface) => ({
  id: s.id,
  sessionId: s.sessionId,
  title: s.title,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  version: s.version,
  kinds: s.parts.map((p) => p.kind),
});

export interface CommentWait {
  sessionId?: string;
  surfaceId?: string;
  author?: string;
  afterSeq?: number;
  waitSeconds: number;
}

// Lean comment shape attached to agent-facing responses.
export const feedbackView = (c: Comment) => ({
  surfaceId: c.surfaceId,
  surfaceTitle: c.surfaceTitle,
  text: c.text,
  at: c.createdAt,
});

export type Feedback = ReturnType<typeof feedbackView>;

export function createApp({
  store,
  viewerHtml,
  guideMarkdown,
  setupText,
  authToken,
  version,
  upgradeCommand,
  fetchLatestRelease,
}: AppOptions) {
  const app = new Hono();
  const bus = new EventBus();

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

  async function publishSurface(input: {
    parts: SurfacePart[];
    title?: string;
    session?: string;
    sessionTitle?: string;
    agent?: string;
    cwd?: string;
  }): Promise<
    { surface: Surface; userFeedback?: Feedback[] } | { error: string; status: 400 | 404 | 413 }
  > {
    if (input.parts.length === 0) {
      return { error: "a surface needs at least one part", status: 400 };
    }
    if (partsByteLength(input.parts) > MAX_SURFACE_BYTES) {
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
        title: input.sessionTitle,
        cwd: input.cwd,
      });
      bus.broadcast({ type: "session-created", id: session.id });
      sessionId = session.id;
    }
    const surface = await store.createSurface({
      sessionId,
      parts: input.parts,
      title: input.title,
    });
    if (!surface) return { error: "session not found", status: 404 };
    bus.broadcast({ type: "surface-created", id: surface.id, sessionId, version: 1 });
    return { surface, userFeedback: await collectFeedback(sessionId) };
  }

  async function reviseSurface(
    id: string,
    patch: { parts?: SurfacePart[]; title?: string },
  ): Promise<
    { surface: Surface; userFeedback?: Feedback[] } | { error: string; status: 400 | 404 | 413 }
  > {
    if (patch.parts) {
      if (patch.parts.length === 0) {
        return { error: "a surface needs at least one part", status: 400 };
      }
      if (partsByteLength(patch.parts) > MAX_SURFACE_BYTES) {
        return { error: `surface exceeds ${MAX_SURFACE_BYTES} bytes`, status: 413 };
      }
    }
    const surface = await store.updateSurface(id, patch);
    if (!surface) return { error: "surface not found", status: 404 };
    bus.broadcast({
      type: "surface-updated",
      id: surface.id,
      sessionId: surface.sessionId,
      version: surface.version,
    });
    return { surface, userFeedback: await collectFeedback(surface.sessionId) };
  }

  async function createComment(input: {
    text: string;
    surface?: string;
    session?: string;
    author: string;
  }): Promise<
    { comment: Comment; userFeedback?: Feedback[] } | { error: string; status: 400 | 404 }
  > {
    let sessionId = input.session;
    if (input.surface) {
      const surface = await store.getSurface(input.surface);
      if (!surface) return { error: "surface not found", status: 404 };
      sessionId = surface.sessionId;
    }
    if (!sessionId) return { error: 'provide "surface" or "session" id', status: 400 };
    const comment = await store.createComment({
      sessionId,
      surfaceId: input.surface,
      author: input.author,
      text: input.text.trim(),
    });
    if (!comment) return { error: "session not found", status: 404 };
    bus.broadcast({
      type: "comment-created",
      id: comment.id,
      sessionId: comment.sessionId,
      surfaceId: comment.surfaceId,
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
    const query = { sessionId: q.sessionId, surfaceId: q.surfaceId, afterSeq };
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
          if (q.surfaceId && event.surfaceId !== q.surfaceId) return;
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
    const lastSeq = comments.length > 0 ? comments[comments.length - 1].seq : (afterSeq ?? 0);
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
    const [sessions, surfaces] = await Promise.all([store.listSessions(), store.listSurfaces()]);
    const counts = new Map<string, number>();
    for (const s of surfaces) counts.set(s.sessionId, (counts.get(s.sessionId) ?? 0) + 1);
    return c.json(sessions.map((s) => ({ ...s, surfaceCount: counts.get(s.id) ?? 0 })));
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

  const listSessionSurfaces = async (c: any) => {
    const session = await store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);
    const surfaces = await store.listSurfaces(session.id);
    return c.json(surfaces.map(surfaceMeta));
  };
  app.get("/api/sessions/:id/surfaces", listSessionSurfaces);
  app.get("/api/sessions/:id/snippets", listSessionSurfaces); // legacy alias

  // --- surfaces ---

  const getSurface = async (c: any) => {
    const surface = await store.getSurface(c.req.param("id"));
    if (!surface) return c.json({ error: "surface not found" }, 404);
    return c.json(surface);
  };
  app.get("/api/surfaces/:id", getSurface);
  app.get("/api/snippets/:id", getSurface); // legacy alias

  // Accepts either an existing session id, or agent/cwd fields to
  // auto-create a session — so a bare `curl` one-liner works with no ceremony.
  app.post("/api/surfaces", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.parts)) {
      return c.json({ error: 'body must include a "parts" array' }, 400);
    }
    return publish(c, body, body.parts as SurfacePart[]);
  });

  // Legacy html-only entry — sugar for a single html part.
  app.post("/api/snippets", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.html !== "string" || !body.html.trim()) {
      return c.json({ error: 'body must include non-empty "html" string' }, 400);
    }
    return publish(c, body, [htmlPart(body.html)]);
  });

  async function publish(c: any, body: any, parts: SurfacePart[]) {
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
    // surfaces: a `parts` array; snippets: an `html` string (single html part).
    let parts: SurfacePart[] | undefined;
    if (Array.isArray(body.parts)) parts = body.parts as SurfacePart[];
    else if (typeof body.html === "string") parts = [htmlPart(body.html)];
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
  app.put("/api/snippets/:id", revise); // legacy alias

  const remove = async (c: any) => {
    const surface = await store.getSurface(c.req.param("id"));
    if (!surface) return c.json({ error: "surface not found" }, 404);
    await store.removeSurface(surface.id);
    bus.broadcast({ type: "surface-deleted", id: surface.id, sessionId: surface.sessionId });
    return c.json({ ok: true });
  };
  app.delete("/api/surfaces/:id", remove);
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
      session: typeof body.session === "string" ? body.session : undefined,
      author: typeof body.author === "string" ? body.author : "user",
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(
      { ...result.comment, ...(result.userFeedback && { userFeedback: result.userFeedback }) },
      201,
    );
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
  app.get("/api/comments", async (c) => {
    const result = await waitForComments({
      sessionId: c.req.query("session"),
      surfaceId: c.req.query("surface") ?? c.req.query("snippet"),
      author: c.req.query("author"),
      afterSeq: c.req.query("after") ? Number(c.req.query("after")) : undefined,
      waitSeconds: Number(c.req.query("wait") ?? 0) || 0,
    });
    return c.json(result);
  });

  // --- rendering ---

  // Serves one html part of a surface as a themed, sandboxed document. The
  // viewer points an iframe here per html part; diff parts render natively in
  // the viewer (they are data, not arbitrary markup) and never reach here.
  app.get("/s/:id", async (c) => {
    const surface = await store.getSurface(c.req.param("id"));
    if (!surface) return c.text("Surface not found", 404);
    const ver = c.req.query("ver");
    let title = surface.title;
    let parts = surface.parts;
    if (ver && Number(ver) !== surface.version) {
      const old = surface.history.find((h) => h.version === Number(ver));
      if (!old) return c.text(`Version ${ver} not available`, 404);
      title = old.title;
      parts = old.parts;
    }
    const idx = Number(c.req.query("part") ?? 0);
    const part = parts[idx];
    if (!part || part.kind !== "html") return c.text("No html part at that index", 404);
    c.header("X-Content-Type-Options", "nosniff");
    return c.html(renderHtmlPage({ title, html: part.html }));
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
    publishSurface,
    reviseSurface,
    createComment,
    waitForComments,
    guide: guideMarkdown,
  });

  return app;
}

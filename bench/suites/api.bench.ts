// End-to-end HTTP benchmarks against the real Hono app (in-process via
// `app.request`, so no socket noise between the measurement and the handler).
//
// These are the numbers a user actually feels: what an agent's publish costs,
// what a viewer's stream load costs, and what a surface iframe costs to serve.
//
// Response SIZE is recorded alongside latency and matters just as much. Every
// byte here is parsed and retained by the browser tab, and the two most recent
// viewer perf fixes were both about shipping less — so a size regression is a
// real regression even when the server-side timing is unchanged.

import { createApp } from "../../server/app.ts";
import { SqlStore } from "../../server/sqlStore.ts";
import { createSqliteStorage } from "../../server/sqliteStorage.ts";
import type { Store } from "../../server/types.ts";
import { buildWorkspace, HEAVY, surfaceOfKind, TYPICAL } from "../fixtures.ts";
import { bytes, count, memory, retainedHeap, type Suite, type SuiteContext } from "../harness.ts";

const VIEWER_HTML = "<html><head></head><body>viewer</body></html>";

function makeApp(store: Store) {
  return createApp({
    store,
    viewerHtml: VIEWER_HTML,
    guideMarkdown: "# guide",
    setupText: "# setup",
    agentHowtoText: "# agent how-to",
    // Empty version disables the npm-registry update check, keeping the bench
    // off the network (and off a variable that has nothing to do with our code).
    version: "",
  });
}

type App = ReturnType<typeof makeApp>;

const jsonPost = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Drain a response and return its byte length — what the client pays to receive. */
async function responseBytes(app: App, path: string): Promise<number> {
  const res = await app.request(path);
  return Buffer.byteLength(await res.text(), "utf8");
}

/** Issue a request and fully drain the body, so the bench includes serialization. */
const hit = async (app: App, path: string) => {
  await (await app.request(path)).text();
};

async function benchReads(ctx: SuiteContext, app: App, sessionId: string, scale: string) {
  const reads: [string, string][] = [
    ["GET /api/sessions", "/api/sessions"],
    ["GET /api/posts/recent?limit=20", "/api/posts/recent?limit=20"],
    ["GET /api/sessions/:id/posts", `/api/sessions/${sessionId}/posts`],
    // The hydrate flavor is what a viewer tab loads on open — one response
    // carrying the session's whole stream.
    ["GET /api/sessions/:id/posts?hydrate=1", `/api/sessions/${sessionId}/posts?hydrate=1`],
    ["GET /api/comments?session", `/api/comments?session=${sessionId}`],
  ];
  for (const [name, path] of reads) {
    await ctx.time(name, () => hit(app, path), { note: scale });
    ctx.add(bytes("api", `${name} bytes`, await responseBytes(app, path), scale));
  }
}

export const apiSuite: Suite = {
  name: "api",
  description: "HTTP request paths through the real app: latency and response size",
  async run(ctx) {
    // --- reads at two workspace sizes --------------------------------------
    // The same routes at typical and heavy scale. A route whose cost grows with
    // total workspace size (rather than with what it returns) shows up as a gap
    // between these two.
    for (const [label, shape] of [
      ["typical", TYPICAL],
      ["heavy", HEAVY],
    ] as const) {
      const store = new SqlStore(createSqliteStorage());
      const built = await buildWorkspace(store, shape);
      const app = makeApp(store);
      await benchReads(
        {
          ...ctx,
          add: (r) => ctx.add({ ...r, name: `${label}: ${r.name}` }),
          time: (name, fn, opts) => ctx.time(`${label}: ${name}`, fn, opts),
        },
        app,
        built.busiestSessionId,
        `${built.totalPosts} posts / ${built.totalComments} comments`,
      );
    }

    // --- writes ------------------------------------------------------------
    {
      const store = new SqlStore(createSqliteStorage());
      const built = await buildWorkspace(store, TYPICAL);
      const app = makeApp(store);
      const scale = `${built.totalPosts} posts`;

      const publishBody = {
        session: built.busiestSessionId,
        title: "bench",
        parts: [surfaceOfKind("markdown", "small")],
      };
      await ctx.time(
        "POST /api/posts (publish)",
        async () => {
          await (await app.request("/api/posts", jsonPost(publishBody))).text();
        },
        { note: scale },
      );

      const target = built.postIds[0];
      let rev = 0;
      await ctx.time(
        "PUT /api/posts/:id (revise)",
        async () => {
          const res = await app.request(`/api/posts/${target}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: `rev ${rev++}` }),
          });
          await res.text();
        },
        { note: scale },
      );

      await ctx.time(
        "POST /api/comments",
        async () => {
          const res = await app.request(
            "/api/comments",
            // Comments attach to a post, not a session (see createComment).
            jsonPost({ surface: target, text: "bench comment" }),
          );
          await res.text();
        },
        { note: scale },
      );
    }

    // --- surface documents (/s/:id) ----------------------------------------
    // The route each sandboxed iframe loads. Cold is a real render; warm is a
    // render-cache hit. A viewer showing N surfaces issues N of these, so the
    // warm number is multiplied by everything on screen.
    {
      const store = new SqlStore(createSqliteStorage());
      const session = await store.createSession({ agent: "bench", title: "surfaces" });
      const perKind: Record<string, string> = {};
      for (const kind of ["html", "markdown", "code", "diff", "terminal"]) {
        const post = await store.createPost({
          sessionId: session.id,
          title: kind,
          surfaces: [surfaceOfKind(kind, "small")] as never,
        });
        if (post) perKind[kind] = post.id;
      }
      const app = makeApp(store);

      // The viewer appends `&theme=&mode=` to every surface iframe src (Card.tsx),
      // and the server renders differently when the mode is pinned — so a bench
      // that omits them measures a URL shape no viewer ever sends, and would score
      // a change to the pinned path as no change at all. Match the real client.
      const viewerQuery = "part=0&theme=github&mode=dark";
      for (const [kind, id] of Object.entries(perKind)) {
        const path = `/s/${id}?${viewerQuery}`;
        // Warm: every request after the first hits the memoized document.
        await ctx.time(`GET /s/:id ${kind} (cache hit)`, () => hit(app, path), {
          note: "render-cache hit",
        });
        ctx.add(bytes("api", `GET /s/:id ${kind} bytes`, await responseBytes(app, path)));
      }

      // Cold: force a miss on EVERY iteration. `?theme=` is part of the cache key
      // but an unknown id resolves to the default theme (themeById falls back), so
      // a counter in the theme slot gives a fresh key with byte-identical render
      // work. Rotating over the three real themes would not do it — after three
      // iterations they are all cached and the rest of the run measures hits.
      // This is what a first view, a theme switch, or a cache eviction costs.
      for (const [kind, id] of Object.entries(perKind)) {
        let n = 0;
        await ctx.time(
          `GET /s/:id ${kind} (cache miss)`,
          () => hit(app, `/s/${id}?part=0&mode=dark&theme=bench-${n++}`),
          { note: "forced re-render", minSamples: 7, minMs: 300 },
        );
      }
    }

    // --- viewer document ----------------------------------------------------
    {
      const store = new SqlStore(createSqliteStorage());
      const app = makeApp(store);
      await ctx.time("GET / (viewer document)", () => hit(app, "/"), {
        note: "in-memory single-file viewer",
      });
    }

    // --- render cache footprint ---------------------------------------------
    // MAX_RENDER_CACHE bounds the ENTRY COUNT, not the bytes, so the ceiling is
    // "512 × whatever a document happens to weigh". This measures what a
    // realistically-filled cache actually holds — the number that decides whether
    // that bound is generous or dangerous.
    if (ctx.matches("render cache heap (64 mixed surfaces)")) {
      const store = new SqlStore(createSqliteStorage());
      const session = await store.createSession({ agent: "bench", title: "cache" });
      const ids: string[] = [];
      for (let i = 0; i < 64; i++) {
        const kind = ["markdown", "code", "diff", "terminal", "html"][i % 5];
        const post = await store.createPost({
          sessionId: session.id,
          title: `p${i}`,
          surfaces: [surfaceOfKind(kind, "small", i)] as never,
        });
        if (post) ids.push(post.id);
      }
      const app = makeApp(store);
      // Warm the shared highlighter first so its one-time heap isn't billed here.
      await hit(app, `/s/${ids[0]}?part=0`);
      const { retained } = await retainedHeap(async () => {
        const fresh = makeApp(store);
        for (const id of ids) await hit(fresh, `/s/${id}?part=0`);
        return fresh;
      });
      ctx.add(
        memory(
          "api",
          "render cache heap (64 mixed surfaces)",
          retained,
          "cache holds up to 512 entries",
        ),
      );
      ctx.add(
        count(
          "api",
          "render cache entries per surface view",
          1,
          "one entry per (post, surface, version, theme, mode)",
        ),
      );
    }
  },
};

/** Exported for the memory suite, which boots an app of its own. */
export { makeApp as createBenchApp };

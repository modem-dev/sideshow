// Live-feed benchmarks: the SSE fan-out and the comment long-poll.
//
// This is the path most likely to burn CPU while nobody is looking. A publish
// broadcasts to every open viewer tab; each tab holds a connection for the life
// of the session and gets a keepalive ping every 15s. An agent mid-task can
// publish in a tight loop, so per-event cost is multiplied by both the event
// rate and the tab count.
//
// The per-connection heap number matters for the same reason: connections are
// long-lived, so whatever a connection retains is retained for hours.

import { createApp } from "../../server/app.ts";
import { EventBus } from "../../server/events.ts";
import { SqlStore } from "../../server/sqlStore.ts";
import { createSqliteStorage } from "../../server/sqliteStorage.ts";
import { buildWorkspace, surfaceOfKind, TYPICAL } from "../fixtures.ts";
import { count, memory, retainedHeap, type Suite, time } from "../harness.ts";

function makeApp(store: SqlStore) {
  return createApp({
    store,
    viewerHtml: "<html><head></head><body>viewer</body></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    agentHowtoText: "# agent how-to",
    version: "",
  });
}

/**
 * Open an SSE connection and collect events until `expected` data frames have
 * arrived. Returns a stop() that aborts the request, so a bench can't leak a
 * held connection into the next one (the app caps concurrent holds, and a leak
 * would show up as a mysterious 503 several benches later).
 */
function openSse(
  app: ReturnType<typeof makeApp>,
  onEvent: () => void,
): { stop: () => void; ready: Promise<void> } {
  const controller = new AbortController();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  void (async () => {
    try {
      const res = await app.request("/api/events", { signal: controller.signal });
      const body = res.body;
      if (!body) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.includes("event: hello")) markReady();
          else if (frame.includes("data:") && !frame.includes("event: ping")) onEvent();
        }
      }
    } catch {
      // Aborting the request is the normal way these end.
    }
  })();

  return { stop: () => controller.abort(), ready };
}

export const eventsSuite: Suite = {
  name: "events",
  description: "SSE fan-out, event bus dispatch, and comment long-poll wakeups",
  async run(ctx) {
    // --- raw bus dispatch ---------------------------------------------------
    // The floor: what a broadcast costs before any serialization or I/O. If this
    // number moves, the cost is structural (listener bookkeeping), not transport.
    for (const subscribers of [1, 10, 100]) {
      const bus = new EventBus();
      let seen = 0;
      for (let i = 0; i < subscribers; i++) bus.subscribe(() => seen++);
      await ctx.time(
        `bus.broadcast → ${subscribers} subscribers`,
        () => bus.broadcast({ type: "post-updated", id: "p", sessionId: "s", version: 2 }),
        { note: `${subscribers} listeners` },
      );
      void seen;
    }

    // --- SSE end to end -----------------------------------------------------
    // A publish, from the write landing to the frame arriving on N open streams.
    // This includes JSON serialization and the stream writes — the part that
    // actually scales with open tabs.
    for (const tabs of [1, 5, 20]) {
      if (!ctx.matches(`publish → SSE delivery to ${tabs} tabs`)) continue;
      const store = new SqlStore(createSqliteStorage());
      const built = await buildWorkspace(store, { ...TYPICAL, sessions: 1, postsPerSession: 2 });
      const app = makeApp(store);

      let delivered = 0;
      const conns = Array.from({ length: tabs }, () => openSse(app, () => delivered++));
      await Promise.all(conns.map((c) => c.ready));

      const surface = surfaceOfKind("markdown", "small");
      const publishOnce = async () => {
        const target = delivered + tabs;
        const res = await app.request("/api/posts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session: built.busiestSessionId,
            title: "bench",
            parts: [surface],
          }),
        });
        await res.text();
        // Wait until every open stream has actually seen it — otherwise this
        // measures the write and leaves the fan-out to happen off-clock.
        while (delivered < target) await new Promise((r) => setImmediate(r));
      };

      ctx.add(
        await time("events", `publish → SSE delivery to ${tabs} tabs`, publishOnce, {
          note: `${tabs} open streams`,
          minSamples: 10,
          minMs: 400,
        }),
      );
      for (const c of conns) c.stop();
      // Let the aborts settle so the next iteration starts from zero holds.
      await new Promise((r) => setTimeout(r, 20));
      ctx.add(
        count("events", `frames per publish (${tabs} tabs)`, tabs, "one frame per open stream"),
      );
    }

    // --- per-connection heap -------------------------------------------------
    // Long-lived by nature: a tab left open all day holds one of these.
    if (ctx.matches("heap per open SSE connection")) {
      const store = new SqlStore(createSqliteStorage());
      await buildWorkspace(store, { ...TYPICAL, sessions: 1, postsPerSession: 2 });
      const app = makeApp(store);
      const N = 20;
      const { retained, value } = await retainedHeap(async () => {
        const conns = Array.from({ length: N }, () => openSse(app, () => {}));
        await Promise.all(conns.map((c) => c.ready));
        return conns;
      });
      ctx.add(
        memory(
          "events",
          "heap per open SSE connection",
          Math.round(retained / N),
          `measured across ${N} concurrent streams`,
        ),
      );
      for (const c of value) c.stop();
      await new Promise((r) => setTimeout(r, 20));
    }

    // --- comment long-poll ---------------------------------------------------
    // The agent-side half of the feedback loop: an agent parks on
    // /api/comments?wait and must be woken promptly when the user comments.
    // Latency here is felt directly as "the agent didn't notice my comment".
    if (ctx.matches("comment long-poll wakeup latency")) {
      const store = new SqlStore(createSqliteStorage());
      const session = await store.createSession({ agent: "bench", title: "poll" });
      // Comments attach to a post, so the poll needs one to point at.
      const post = await store.createPost({
        sessionId: session.id,
        title: "poll target",
        surfaces: [surfaceOfKind("markdown", "small")] as never,
      });
      const app = makeApp(store);
      let n = 0;
      ctx.add(
        await time(
          "events",
          "comment long-poll wakeup latency",
          async () => {
            const waiting = (async () => {
              const res = await app.request(
                `/api/comments?session=${session.id}&author=user&wait=5`,
              );
              return res.text();
            })();
            // Yield so the wait is genuinely parked before the comment lands.
            await new Promise((r) => setImmediate(r));
            const posted = await app.request("/api/comments", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ surface: post!.id, text: `c${n++}`, author: "user" }),
            });
            await posted.text();
            await waiting;
          },
          { note: "post → parked agent wakes", minSamples: 10, minMs: 400 },
        ),
      );
    }
  },
};

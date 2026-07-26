import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

const TOKEN = "worker-integration-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

type PostResult = {
  id: string;
  sessionId: string;
  title: string;
  version: number;
  surfaces: Array<{ id: string; kind: string }>;
  userFeedback?: Array<{ text: string }>;
};

type AssetResult = {
  id: string;
  sessionId: string;
  byteLength: number;
  url: string;
};

function json(body: unknown, method = "POST") {
  return {
    method,
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function expectJson<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

async function startWorker(
  persistTo: string,
  vars: Record<string, string>,
): Promise<Unstable_DevWorker> {
  // The API type requires a positional script, but leaving it undefined makes
  // Wrangler resolve `main` from the checked-in config, just like deploy/dev.
  return unstable_dev(undefined as never, {
    config: "wrangler.jsonc",
    local: true,
    persist: true,
    persistTo,
    vars,
    logLevel: "error",
    experimental: {
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      watch: false,
    },
  });
}

test(
  "the local Wrangler runtime wires the Worker, Durable Object, and SQLite store",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "sideshow-worker-integration-"));
    const persistTo = join(root, "state");
    let worker: Unstable_DevWorker | undefined;

    let stopping: Promise<void> | undefined;
    const stopWorker = async () => {
      if (!worker) return;
      if (stopping) return stopping;
      const active = worker;
      stopping = active
        .stop()
        .then(() => {
          if (worker === active) worker = undefined;
        })
        .finally(() => {
          stopping = undefined;
        });
      return stopping;
    };
    t.signal.addEventListener("abort", () => void stopWorker().catch(() => {}), { once: true });
    t.after(async () => {
      try {
        await stopWorker();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    worker = await startWorker(persistTo, { SIDESHOW_TOKEN: "" });
    const unconfigured = await worker.fetch("/");
    assert.equal(unconfigured.status, 503);
    assert.match(await unconfigured.text(), /wrangler secret put SIDESHOW_TOKEN/);
    await stopWorker();

    worker = await startWorker(persistTo, { SIDESHOW_TOKEN: TOKEN });

    assert.equal((await worker.fetch("/api/sessions")).status, 401);

    const marker = '<p id="worker-marker">real workerd render</p>';
    const post = await expectJson<PostResult>(
      await worker.fetch(
        "/api/posts",
        json({
          agent: "worker-integration",
          sessionTitle: "Durable workspace",
          title: "Worker post",
          surfaces: [{ kind: "html", html: marker }],
        }),
      ),
      201,
    );
    assert.ok(post.id);
    assert.ok(post.sessionId);
    assert.equal(post.version, 1);
    assert.equal(post.surfaces[0].kind, "html");

    assert.equal((await worker.fetch(`/api/posts/${post.id}`)).status, 401);

    const eventStream = await worker.fetch(`/api/events?session=${post.sessionId}`, {
      headers: AUTH,
    });
    assert.equal(eventStream.status, 200);
    assert.match(eventStream.headers.get("content-type") ?? "", /text\/event-stream/);
    const eventReader = eventStream.body?.getReader();
    assert.ok(eventReader);
    const connected = await eventReader.read();
    assert.match(new TextDecoder().decode(connected.value), /event: hello/);
    const nextEvent = (async () => {
      let text = "";
      while (!text.includes('"type":"comment-created"')) {
        const chunk = await eventReader.read();
        if (chunk.done) throw new Error("SSE stream ended before comment-created");
        text += new TextDecoder().decode(chunk.value);
      }
      return text;
    })();
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expectJson(
        await worker.fetch(
          "/api/comments",
          json({ surface: post.id, text: "event stream probe", author: "worker-agent" }),
        ),
        201,
      );
      const event = await Promise.race([
        nextEvent,
        new Promise<never>((_resolve, reject) => {
          eventTimer = setTimeout(
            () => reject(new Error("timed out waiting for SSE event")),
            2_000,
          );
        }),
      ]);
      assert.match(event, /comment-created/);
    } finally {
      if (eventTimer) clearTimeout(eventTimer);
      await eventReader.cancel();
    }

    const rendered = await worker.fetch(`/p/${post.id}?surface=0&ver=1&theme=gruvbox&mode=dark`, {
      headers: AUTH,
    });
    assert.equal(rendered.status, 200);
    assert.match(await rendered.text(), /worker-marker/);
    assert.equal(rendered.headers.get("content-security-policy"), "sandbox allow-scripts");
    assert.equal(rendered.headers.get("x-content-type-options"), "nosniff");
    assert.match(rendered.headers.get("cache-control") ?? "", /immutable/);

    assert.equal((await worker.fetch(`/p/${post.id}.png?card=1`, { method: "HEAD" })).status, 401);
    const screenshot = await worker.fetch(`/p/${post.id}.png?card=1`, {
      method: "HEAD",
      headers: AUTH,
    });
    assert.equal(screenshot.status, 200);
    assert.equal(screenshot.headers.get("content-type"), "image/png");
    assert.equal((await screenshot.arrayBuffer()).byteLength, 0);
    assert.equal(
      (await worker.fetch("/p/missing.png", { method: "HEAD", headers: AUTH })).status,
      404,
    );

    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const asset = await expectJson<AssetResult>(
      await worker.fetch(
        "/api/assets",
        json({
          session: post.sessionId,
          filename: "worker.bin",
          contentType: "application/octet-stream",
          data: Buffer.from(bytes).toString("base64"),
        }),
      ),
      201,
    );
    assert.equal(asset.sessionId, post.sessionId);
    assert.equal(asset.byteLength, bytes.byteLength);

    const servedAsset = await worker.fetch(`/a/${asset.id}`, { headers: AUTH });
    assert.equal(servedAsset.status, 200);
    assert.equal(servedAsset.headers.get("content-type"), "application/octet-stream");
    assert.equal(servedAsset.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(new Uint8Array(await servedAsset.arrayBuffer()), bytes);

    await expectJson(await worker.fetch("/api/theme", json({ id: "gruvbox" }, "PUT")), 200);

    const pendingFeedback = worker.fetch(
      `/api/comments?session=${post.sessionId}&author=user&wait=2`,
      { headers: AUTH },
    );
    // Give the held request time to register before the write, matching the
    // direct-app wakeup test and exercising the DO's in-memory event bus path.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expectJson(
      await worker.fetch(
        "/api/comments",
        json({ surface: post.id, text: "wake the worker", author: "user" }),
      ),
      201,
    );
    let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
    let feedbackResponse: Awaited<typeof pendingFeedback>;
    try {
      feedbackResponse = await Promise.race([
        pendingFeedback,
        new Promise<never>((_resolve, reject) => {
          feedbackTimer = setTimeout(
            () => reject(new Error("long-poll was not woken by the DO event bus")),
            1_000,
          );
        }),
      ]);
    } finally {
      if (feedbackTimer) clearTimeout(feedbackTimer);
    }
    const waited = await expectJson<{ comments: Array<{ text: string }> }>(feedbackResponse, 200);
    assert.deepEqual(
      waited.comments.map((comment) => comment.text),
      ["wake the worker"],
    );

    const afterWait = await expectJson<PostResult>(
      await worker.fetch(
        `/api/posts/${post.id}`,
        json(
          {
            title: "Worker post v2",
            surfaces: [{ kind: "html", html: `${marker}<p>v2</p>` }],
          },
          "PUT",
        ),
      ),
      200,
    );
    assert.equal(afterWait.userFeedback, undefined);

    await expectJson(
      await worker.fetch(
        "/api/comments",
        json({ surface: post.id, text: "persist this feedback", author: "user" }),
      ),
      201,
    );
    const piggybacked = await expectJson<PostResult>(
      await worker.fetch(
        `/api/posts/${post.id}`,
        json(
          {
            title: "Worker post v3",
            surfaces: [{ kind: "html", html: `${marker}<p>v3</p>` }],
          },
          "PUT",
        ),
      ),
      200,
    );
    assert.deepEqual(
      piggybacked.userFeedback?.map((feedback) => feedback.text),
      ["persist this feedback"],
    );

    await stopWorker();
    worker = await startWorker(persistTo, {
      SIDESHOW_TOKEN: TOKEN,
      SIDESHOW_PUBLIC_READ: "session",
    });

    const publicPost = await expectJson<PostResult>(
      await worker.fetch(`/api/posts/${post.id}`),
      200,
    );
    assert.equal(publicPost.title, "Worker post v3");
    assert.equal((await worker.fetch("/api/sessions")).status, 401);

    const persistedPost = await expectJson<PostResult>(
      await worker.fetch(`/api/posts/${post.id}`, { headers: AUTH }),
      200,
    );
    assert.equal(persistedPost.title, "Worker post v3");
    assert.equal(persistedPost.version, 3);
    assert.equal((persistedPost.surfaces[0] as { html?: string }).html, `${marker}<p>v3</p>`);

    const persistedTheme = await expectJson<{ id: string }>(
      await worker.fetch("/api/theme", { headers: AUTH }),
      200,
    );
    assert.equal(persistedTheme.id, "gruvbox");

    const persistedAsset = await worker.fetch(`/a/${asset.id}`, { headers: AUTH });
    assert.equal(persistedAsset.status, 200);
    assert.deepEqual(new Uint8Array(await persistedAsset.arrayBuffer()), bytes);

    await expectJson(
      await worker.fetch(
        "/api/comments",
        json({ surface: post.id, text: "feedback after restart", author: "user" }),
      ),
      201,
    );
    const afterRestart = await expectJson<PostResult>(
      await worker.fetch(
        `/api/posts/${post.id}`,
        json(
          {
            title: "Worker post v4",
            surfaces: [{ kind: "html", html: `${marker}<p>v4</p>` }],
          },
          "PUT",
        ),
      ),
      200,
    );
    assert.deepEqual(
      afterRestart.userFeedback?.map((feedback) => feedback.text),
      ["feedback after restart"],
    );

    const sessions = await expectJson<Array<{ id: string; postCount: number }>>(
      await worker.fetch("/api/sessions", { headers: AUTH }),
      200,
    );
    assert.deepEqual(
      sessions.map(({ id, postCount }) => ({ id, postCount })),
      [{ id: post.sessionId, postCount: 1 }],
    );
  },
);

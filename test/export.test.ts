import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { renderSessionExport } from "../server/exportPage.ts";
import { EXTERNAL_LINK_PROTOCOLS, OPEN_LINK_PROMPT } from "../server/bridgePolicy.ts";
import { renderSurfaceDocument } from "../server/surfacePage.ts";
import { JsonFileStore } from "../server/storage.ts";
import { decodeBase64, encodeBase64 } from "../server/base64.ts";

function makeAppWithStore(authToken?: string, opts?: { publicRead?: "session" | "full" }) {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-export-"));
  const store = new JsonFileStore(join(dir, "data.json"));
  const app = createApp({
    store,
    viewerHtml: "<html><head></head><body>viewer</body></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    agentHowtoText: "# agent how-to",
    authToken,
    ...opts,
  });
  return { app, store };
}

function makeApp(authToken?: string, opts?: { publicRead?: "session" | "full" }) {
  return makeAppWithStore(authToken, opts).app;
}

const json = (body: unknown, token?: string) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

// A 1x1 transparent PNG.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function publish(app: ReturnType<typeof createApp>, body: unknown, token?: string) {
  const res = await app.request("/api/posts", json(body, token));
  const parsed = (await res.json()) as { id: string; sessionId: string; version: number };
  assert.equal(res.status, 201, JSON.stringify(parsed));
  return parsed;
}

async function exportSession(app: ReturnType<typeof createApp>, sessionId: string, query = "") {
  return app.request(`/api/sessions/${sessionId}/export${query}`);
}

test("export renders one sandboxed srcdoc iframe per sandboxed surface, posts chronological", async () => {
  const app = makeApp();

  // Upload an asset so the image surface resolves.
  const uploaded = (await (
    await app.request("/api/assets", json({ data: TINY_PNG_B64, contentType: "image/png" }))
  ).json()) as { id: string; sessionId: string };
  const sessionId = uploaded.sessionId;

  const first = await publish(app, {
    session: sessionId,
    title: "First card",
    surfaces: [
      { kind: "html", html: "<p>hello</p>" },
      { kind: "markdown", markdown: "# Heading\n\ntext" },
      { kind: "json", data: { a: 1, b: [2, 3] } },
      { kind: "image", assetId: uploaded.id },
      { kind: "terminal", text: "$ ls\nfile.txt" },
    ],
  });
  assert.ok(first.id);
  await publish(app, {
    session: sessionId,
    title: "Second card",
    surfaces: [{ kind: "html", html: "<p>bye</p>" }],
  });

  const res = await exportSession(app, sessionId);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();

  // html + markdown + terminal are sandboxed → 3 frames on the first card, plus
  // 1 on the second = 4 srcdoc iframes; json + image are native (no iframe).
  const frames = html.match(/sandbox="allow-scripts"/g) ?? [];
  assert.equal(frames.length, 4);
  // Every sandboxed surface carries srcdoc.
  assert.equal(
    (html.match(/<iframe class="ss-frame[^"]*" sandbox="allow-scripts" srcdoc=/g) ?? []).length,
    4,
  );

  // Chronological order: First card appears before Second card.
  assert.ok(html.indexOf("First card") < html.indexOf("Second card"));
});

test("image surface inlines a data URI; a missing asset degrades to a note", async () => {
  const app = makeApp();
  const uploaded = (await (
    await app.request("/api/assets", json({ data: TINY_PNG_B64, contentType: "image/png" }))
  ).json()) as { id: string; sessionId: string };
  const sessionId = uploaded.sessionId;

  await publish(app, {
    session: sessionId,
    title: "Has image",
    surfaces: [
      { kind: "image", assetId: uploaded.id, alt: "a pixel", caption: "tiny" },
      { kind: "image", assetId: "does-not-exist" },
    ],
  });

  const html = await (await exportSession(app, sessionId)).text();
  assert.ok(html.includes("data:image/png;base64,"), "inlines the real asset");
  assert.ok(html.includes(encodeBase64(decodeBase64(TINY_PNG_B64))), "inlines the exact bytes");
  assert.ok(html.includes("no longer available"), "missing asset → note, no throw");
});

test("hostile html surface and title stay inert (attribute-escaped srcdoc, escaped titles)", async () => {
  const app = makeApp();
  const HOSTILE = `</iframe><script>alert(1)</script>`;
  const { sessionId } = await publish(app, {
    title: `"><script>evil()</script>`,
    surfaces: [{ kind: "html", html: HOSTILE }],
  });

  const html = await (await exportSession(app, sessionId)).text();
  // The raw breakout sequences never appear unescaped in the shell.
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("</iframe><script>"));
  assert.ok(!html.includes("<script>evil()</script>"));
  // Only their escaped forms survive.
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("only allowlisted raster content types are inlined; a crafted MIME can't inject attributes", async () => {
  const app = makeApp();
  // Distinct byte payloads — asset ids are content-addressed, so identical
  // bytes would collapse to one asset and one contentType.
  const hostile = (await (
    await app.request(
      "/api/assets",
      json({
        data: encodeBase64(new Uint8Array([1, 2, 3])),
        // Breaks out of the src attribute if interpolated raw.
        contentType: 'image/png" onload="alert(1)',
      }),
    )
  ).json()) as { id: string; sessionId: string };
  const svg = (await (
    await app.request(
      "/api/assets",
      json({
        data: encodeBase64(new Uint8Array([4, 5, 6])),
        contentType: "image/svg+xml",
      }),
    )
  ).json()) as { id: string };

  await publish(app, {
    session: hostile.sessionId,
    title: "mime",
    surfaces: [
      { kind: "image", assetId: hostile.id },
      { kind: "image", assetId: svg.id },
    ],
  });

  const html = await (await exportSession(app, hostile.sessionId)).text();
  assert.ok(!html.includes("onload="), "crafted MIME never reaches the shell markup");
  assert.ok(!html.includes("data:image/svg"), "svg is not inlined");
  // Both degrade to the omitted note instead of rendering an <img>.
  assert.equal((html.match(/non-image content type/g) ?? []).length, 2);
  assert.ok(!html.includes("<figure"), "no image figure rendered");
});

test("aggregate inline-asset budget: images past the cap degrade to a note", async () => {
  const { app, store } = makeAppWithStore();
  const first = (await (
    await app.request("/api/assets", json({ data: TINY_PNG_B64, contentType: "image/png" }))
  ).json()) as { id: string; sessionId: string };
  const second = (await (
    await app.request(
      "/api/assets",
      json({ data: encodeBase64(new Uint8Array(100)), contentType: "image/png" }),
    )
  ).json()) as { id: string };

  await publish(app, {
    session: first.sessionId,
    title: "budget",
    surfaces: [
      { kind: "image", assetId: first.id },
      { kind: "image", assetId: second.id },
      // A re-reference of the already-inlined asset still charges the budget.
      { kind: "image", assetId: first.id },
    ],
  });

  const session = await store.getSession(first.sessionId);
  assert.ok(session);
  const posts = await store.listPosts(session.id);
  const firstBytes = decodeBase64(TINY_PNG_B64).byteLength;
  const html = await renderSessionExport({
    session,
    items: posts.map((post) => ({ post, comments: [] })),
    origin: "http://localhost:8228",
    themeId: "github",
    generatedAt: "2026-01-01T00:00:00.000Z",
    getAsset: (id) => store.getAsset(id),
    // Exactly one copy of the first asset fits.
    maxInlineAssetBytes: firstBytes,
  });

  assert.equal((html.match(/data:image\/png;base64,/g) ?? []).length, 1, "one image inlined");
  assert.equal((html.match(/inline-image size limit/g) ?? []).length, 2, "two omitted with notes");
});

// Surface COUNT is unbounded (only per-post/per-session TEXT bytes are capped),
// so a rejected asset MUST be fetched at most once per export — otherwise a
// session cheaply salted with many references to one bad assetId makes every
// export re-read that blob per reference (a JsonFileStore byte clone, a SqlStore
// blob SELECT), unauthenticated on a publicRead workspace.
test("a rejected asset is fetched once no matter how many surfaces reference it", async () => {
  const { app, store } = makeAppWithStore();
  const { id, sessionId } = (await (
    await app.request(
      "/api/assets",
      json({ data: encodeBase64(new Uint8Array(64)), contentType: "image/svg+xml" }),
    )
  ).json()) as { id: string; sessionId: string };

  await publish(app, {
    session: sessionId,
    title: "repeat rejects",
    surfaces: [
      { kind: "image", assetId: id },
      { kind: "image", assetId: id },
      { kind: "image", assetId: id },
      { kind: "image", assetId: "ZZZmissingZZZ" },
      { kind: "image", assetId: "ZZZmissingZZZ" },
    ],
  });

  const session = await store.getSession(sessionId);
  assert.ok(session);
  const posts = await store.listPosts(session.id);
  const fetched: string[] = [];
  const html = await renderSessionExport({
    session,
    items: posts.map((post) => ({ post, comments: [] })),
    origin: "http://localhost:8228",
    themeId: "github",
    generatedAt: "2026-01-01T00:00:00.000Z",
    getAsset: (assetId) => {
      fetched.push(assetId);
      return store.getAsset(assetId);
    },
  });

  assert.deepEqual(fetched, [id, "ZZZmissingZZZ"], "each rejected asset fetched exactly once");
  // Every reference still renders its own note — memoizing the lookup must not
  // silently drop surfaces from the document.
  assert.equal((html.match(/non-image content type/g) ?? []).length, 3);
  assert.equal((html.match(/no longer available/g) ?? []).length, 2);
});

// The export shell and the live viewer implement the same bridge separately (a
// baked JS string vs bundled TS), so the POLICY is shared (server/bridgePolicy.ts)
// and interpolated. Pin that it really is interpolated — a hardcoded copy here
// would drift silently the next time the policy changes.
test("the shell's link policy is the shared one, not a restatement", async () => {
  const app = makeApp();
  const { sessionId } = await publish(app, {
    title: "policy",
    surfaces: [{ kind: "html", html: "<p>hi</p>" }],
  });
  const html = await (await exportSession(app, sessionId)).text();

  assert.ok(
    html.includes(JSON.stringify(EXTERNAL_LINK_PROTOCOLS)),
    "allowlist interpolated from bridgePolicy",
  );
  assert.ok(
    html.includes(JSON.stringify(OPEN_LINK_PROMPT)),
    "prompt interpolated from bridgePolicy",
  );
  assert.ok(!/'http:'/.test(html), "no hardcoded scheme literal in the shell");
});

// Exporting a session someone already viewed must not re-run shiki / the diff
// SSR for surfaces /s/:id already rendered — those documents are byte-identical.
test("export reuses the render cache for rich surfaces and keys html separately", async () => {
  const { app, store } = makeAppWithStore();
  const { id, sessionId } = await publish(app, {
    title: "cached",
    surfaces: [
      { kind: "markdown", markdown: "# hi" },
      { kind: "html", html: "<p>hi</p>" },
    ],
  });

  // Warm the cache the way the viewer does: one /s/:id fetch per surface.
  await app.request(`/p/${id}?part=0&theme=github`);
  await app.request(`/p/${id}?part=1&theme=github`);

  const session = await store.getSession(sessionId);
  assert.ok(session);
  const posts = await store.listPosts(session.id);
  const built: string[] = [];
  const html = await renderSessionExport({
    session,
    items: posts.map((post) => ({ post, comments: [] })),
    origin: "http://localhost:8228",
    themeId: "github",
    generatedAt: "2026-01-01T00:00:00.000Z",
    getAsset: (assetId) => store.getAsset(assetId),
    renderDocument: async (surface, doc, key) => {
      built.push(`${surface.kind}:${key.index}:${key.html}`);
      return renderSurfaceDocument(surface, doc);
    },
  });

  // The hook sees both surfaces with the identity a cache key needs; the html
  // one is flagged so it can't collide with the /s/:id entry that lacks <base>.
  assert.deepEqual(built, ["markdown:0:false", "html:1:true"]);
  // srcdoc-escaped into the shell, so the pinned <base> carries escaped quotes.
  assert.ok(
    html.includes("&lt;base href=&quot;http://localhost:8228/&quot;&gt;"),
    "html surface pins its base",
  );
});

test("a session over the aggregate surface-byte cap 413s before rendering", async () => {
  const app = makeApp();
  // 3 × 1.5 MB html surfaces: each under the 2 MB per-post cap, together over
  // the 4 MB export input cap.
  const big = "x".repeat(1.5 * 1024 * 1024);
  const { sessionId } = await publish(app, {
    title: "big 1",
    surfaces: [{ kind: "html", html: big }],
  });
  await publish(app, {
    session: sessionId,
    title: "big 2",
    surfaces: [{ kind: "html", html: big }],
  });
  await publish(app, {
    session: sessionId,
    title: "big 3",
    surfaces: [{ kind: "html", html: big }],
  });

  const res = await exportSession(app, sessionId);
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /too large to export/);
});

test("the shell's open-link bridge confirms the destination before opening", async () => {
  const app = makeApp();
  const { sessionId } = await publish(app, {
    title: "links",
    surfaces: [{ kind: "html", html: "<p>x</p>" }],
  });
  const html = await (await exportSession(app, sessionId)).text();
  // Mirrors the viewer (App.tsx): untrusted frames can request opens for any
  // URL, so the normalized href must be confirmed by the reader first. Asserted
  // against the shared constant, not a copy of it, so this can't pass while the
  // shell has silently drifted from bridgePolicy.ts.
  const confirmCall = `window.confirm(${JSON.stringify(OPEN_LINK_PROMPT)} + url.href)`;
  assert.ok(html.includes(confirmCall));
  const confirmAt = html.indexOf(confirmCall);
  const openAt = html.indexOf("window.open(url.href");
  assert.ok(confirmAt !== -1 && openAt !== -1 && confirmAt < openAt, "confirm gates window.open");
});

test("json surface with a script string is escaped in a <pre>", async () => {
  const app = makeApp();
  const { sessionId } = await publish(app, {
    title: "json",
    surfaces: [{ kind: "json", data: { danger: "<script>alert(1)</script>" } }],
  });
  const html = await (await exportSession(app, sessionId)).text();
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("post-anchored comments render escaped; session-level comments excluded", async () => {
  const app = makeApp();
  const { id, sessionId } = await publish(app, {
    title: "commented",
    surfaces: [{ kind: "html", html: "<p>x</p>" }],
  });
  await app.request(
    "/api/comments",
    json({ surface: id, text: "great <b>work</b>", author: "user" }),
  );
  // A session-level comment (no postId) must not appear.
  await app.request("/api/comments", json({ text: "session note", author: "user" }));

  const html = await (await exportSession(app, sessionId)).text();
  assert.ok(html.includes("great &lt;b&gt;work&lt;/b&gt;"), "comment text present and escaped");
  assert.ok(!html.includes("session note"), "session-level comment excluded");
});

test("empty session exports an empty-state; unknown session id 404s", async () => {
  const app = makeApp();
  const session = (await (await app.request("/api/sessions", json({ agent: "e2e" }))).json()) as {
    id: string;
  };
  const html = await (await exportSession(app, session.id)).text();
  assert.ok(html.includes("no posts yet"));

  const missing = await exportSession(app, "nope");
  assert.equal(missing.status, 404);
});

test("auth: token app 401s unauthenticated, ?key works; publicRead session app is open", async () => {
  const app = makeApp("secret");
  const { sessionId } = await publish(
    app,
    { title: "t", surfaces: [{ kind: "html", html: "<p>x</p>" }] },
    "secret",
  );

  const unauth = await exportSession(app, sessionId);
  assert.equal(unauth.status, 401);
  const withKey = await exportSession(app, sessionId, "?key=secret");
  assert.equal(withKey.status, 200);

  const openApp = makeApp("secret", { publicRead: "session" });
  const pub = await publish(
    openApp,
    { title: "t", surfaces: [{ kind: "html", html: "<p>x</p>" }] },
    "secret",
  );
  const openRes = await exportSession(openApp, pub.sessionId);
  assert.equal(openRes.status, 200);
});

test("?theme + ?mode pin the palette into frames; ?download sets a sanitized filename", async () => {
  const app = makeApp();
  const { sessionId } = await publish(app, {
    title: "Themed export!!",
    sessionTitle: "My Session / Name",
    surfaces: [{ kind: "markdown", markdown: "text" }],
  });

  const res = await exportSession(app, sessionId, "?theme=gruvbox&mode=dark");
  const html = await res.text();
  // A hex from the gruvbox dark palette (surface) baked into the pinned frames/shell.
  assert.ok(html.includes("#32302f"), "gruvbox dark palette pinned");

  const dl = await exportSession(app, sessionId, "?download=1");
  const disp = dl.headers.get("content-disposition") ?? "";
  assert.match(disp, /attachment; filename="sideshow-[a-z0-9-]+\.html"/);
});

test("encodeBase64 round-trips with decodeBase64 across the chunk boundary", async () => {
  for (const n of [0, 1, 255, 0x8000 - 1, 0x8000, 0x8000 + 123, 0x10001]) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const round = decodeBase64(encodeBase64(bytes));
    assert.equal(round.length, n);
    assert.deepEqual([...round], [...bytes]);
  }
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { JsonFileStore } from "../server/storage.ts";

function makeApp(
  authToken?: string,
  opts?: {
    publicRead?: "session" | "full";
    basePath?: string;
    viewerHtml?: string;
    screenshots?: boolean;
    maxHoldConnections?: number;
  },
) {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-test-"));
  const store = new JsonFileStore(join(dir, "data.json"));
  const { viewerHtml = "<html><head></head><body>viewer</body></html>", ...rest } = opts ?? {};
  return createApp({
    store,
    viewerHtml,
    guideMarkdown: "# guide",
    setupText: "# setup",
    agentHowtoText: "# agent how-to",
    authToken,
    ...rest,
  });
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const authedJson = (body: unknown, token = "secret") => ({
  ...json(body),
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
});

test("publish without session auto-creates one", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/snippets",
    json({ html: "<p>hi</p>", agent: "pi", title: "First" }),
  );
  assert.equal(res.status, 201);
  const snippet = (await res.json()) as any;
  assert.ok(snippet.id);
  assert.ok(snippet.sessionId);
  assert.equal(snippet.title, "First");
  assert.equal(snippet.version, 1);

  const sessions = (await (await app.request("/api/sessions")).json()) as any;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agent, "pi");
  assert.equal(sessions[0].surfaceCount, 1);
});

test("publish into an existing session groups snippets", async () => {
  const app = makeApp();
  const first = (await (
    await app.request("/api/snippets", json({ html: "<p>1</p>", agent: "amp" }))
  ).json()) as any;
  await app.request("/api/snippets", json({ html: "<p>2</p>", session: first.sessionId }));
  const list = (await (
    await app.request(`/api/sessions/${first.sessionId}/snippets`)
  ).json()) as any;
  assert.equal(list.length, 2);
});

test("publish with sessionTitle names the auto-created session", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/snippets",
    json({ html: "<p>x</p>", agent: "pi", sessionTitle: "Auth refactor" }),
  );
  assert.equal(res.status, 201);
  const snippet = (await res.json()) as any;
  const sessions = (await (await app.request("/api/sessions")).json()) as any;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, snippet.sessionId);
  assert.equal(sessions[0].title, "Auth refactor");
});

test("sessionTitle never retitles an existing session", async () => {
  const app = makeApp();
  const first = (await (
    await app.request("/api/snippets", json({ html: "<p>1</p>", sessionTitle: "Original" }))
  ).json()) as any;
  // the user renames the session in the viewer...
  await app.request(`/api/sessions/${first.sessionId}`, {
    ...json({ title: "User's pick" }),
    method: "PATCH",
  });
  // ...and a later publish carrying a sessionTitle must not clobber it
  const res = await app.request(
    "/api/snippets",
    json({ html: "<p>2</p>", session: first.sessionId, sessionTitle: "Clobber attempt" }),
  );
  assert.equal(res.status, 201);
  const sessions = (await (await app.request("/api/sessions")).json()) as any;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "User's pick");
});

test("publish into unknown session 404s instead of silently creating", async () => {
  const app = makeApp();
  const res = await app.request("/api/snippets", json({ html: "<p>x</p>", session: "nope" }));
  assert.equal(res.status, 404);
});

test("publishes a combined html+diff surface; /s server-renders both parts opaque-sandboxed", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/surfaces",
    json({
      title: "Review",
      parts: [
        { kind: "html", html: "<p>diagram</p>" },
        { kind: "diff", patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b", layout: "split" },
      ],
    }),
  );
  assert.equal(res.status, 201);
  const surface = (await res.json()) as any;
  // the write response is lean — kinds, no part bodies echoed back
  assert.deepEqual(surface.kinds, ["html", "diff"]);
  assert.equal(surface.parts, undefined);

  // the full record keeps the html and the diff patch
  const full = (await (await app.request(`/api/surfaces/${surface.id}`)).json()) as any;
  assert.equal(full.surfaces.length, 2);
  assert.equal(full.surfaces[0].html, "<p>diagram</p>");
  assert.equal(full.surfaces[1].patch, "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b");

  // /s renders the html part...
  const part0 = await app.request(`/s/${surface.id}?part=0`);
  assert.ok((await part0.text()).includes("<p>diagram</p>"));
  // ...and now also server-renders the diff part (no viewer round-trip): the
  // @pierre/diffs SSR output wraps each file in a <diffs-container>.
  const part1 = await app.request(`/s/${surface.id}?part=1`);
  assert.equal(part1.status, 200);
  assert.ok((await part1.text()).includes("diffs-container"));

  // Both carry the `sandbox` CSP response header, so a top-level load of the
  // document (not just the embedded iframe) runs in an opaque origin — never the
  // board origin. allow-scripts keeps the bridge working; allow-same-origin must
  // never appear (it would defeat the sandbox).
  for (const res of [part0, part1]) {
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /\bsandbox\b/);
    assert.match(csp, /\ballow-scripts\b/);
    assert.doesNotMatch(csp, /allow-same-origin/);
  }
});

test("the viewer render round-trip (POST /api/frames + GET /f/:id) is gone", async () => {
  // Rich parts now render server-side at /s/:id, so the transient frame store and
  // its write endpoint were removed; both must be unreachable (no public-read
  // POST exception lingering, no in-memory doc host).
  const app = makeApp();
  assert.equal((await app.request("/api/frames", json({ html: "<p>x</p>" }))).status, 404);
  assert.equal((await app.request("/f/anything")).status, 404);
});

test("GET /s/:id serves the viewer shell with link-preview metadata", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/snippets",
    json({ title: "Auth Flow", html: "<p>diagram</p>", sessionTitle: "Secret session" }),
  );
  const surface = (await res.json()) as any;

  const page = await app.request(`https://board.test/s/${surface.id}`);
  assert.equal(page.status, 200);
  assert.ok(page.headers.get("content-type")?.includes("text/html"));
  assert.equal(page.headers.get("content-security-policy"), null);
  const body = await page.text();
  assert.ok(body.includes("viewer"), "should serve the trusted viewer shell");
  assert.doesNotMatch(body, /<p>diagram<\/p>/, "should not inline agent HTML");
  assert.match(body, /<meta property="og:title" content="Auth Flow">/);
  assert.match(body, /<meta name="twitter:title" content="Auth Flow">/);
  assert.match(body, /<meta property="og:description" content="A https:\/\/sideshow\.sh surface">/);
  assert.match(
    body,
    /<meta name="twitter:description" content="A https:\/\/sideshow\.sh surface">/,
  );
  assert.doesNotMatch(body, /Secret session/);
});

test("GET /s/:id emits absolute token-free canonical and preview image URLs", async () => {
  const app = makeApp("secret");
  const res = await app.request(
    "https://board.test/api/snippets",
    authedJson({ title: "Preview", html: "<p>x</p>" }),
  );
  const surface = (await res.json()) as any;

  const body = await (await app.request(`https://board.test/s/${surface.id}?key=secret`)).text();
  const canonical = `https://board.test/s/${surface.id}`;
  const image = `https://board.test/s/${surface.id}.png?card=1`;
  assert.match(body, new RegExp(`<link rel="canonical" href="${canonical}">`));
  assert.match(body, new RegExp(`<meta property="og:url" content="${canonical}">`));
  assert.match(
    body,
    new RegExp(`<meta property="og:image" content="${image.replace("?", "\\?")}">`),
  );
  assert.match(
    body,
    new RegExp(`<meta name="twitter:image" content="${image.replace("?", "\\?")}">`),
  );
  for (const line of body.split("\n").filter((l) => /canonical|og:|twitter:/.test(l))) {
    assert.doesNotMatch(line, /key=secret|secret/);
  }
});

test("GET /s/:id?part=0 still serves an opaque sandboxed part document", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/snippets",
    json({ title: "Part", html: "<script>window.x=1</script><p>part</p>" }),
  );
  const surface = (await res.json()) as any;

  const part = await app.request(`/s/${surface.id}?part=0`);
  assert.equal(part.status, 200);
  const csp = part.headers.get("content-security-policy") ?? "";
  assert.match(csp, /\bsandbox\b/);
  assert.match(csp, /\ballow-scripts\b/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(await part.text(), /<p>part<\/p>/);
});

test("GET /s/:id escapes surface metadata in preview tags", async () => {
  const app = makeApp();
  const title = `A "quoted" <tag> & more`;
  const res = await app.request("/api/snippets", json({ title, html: "<p>x</p>" }));
  const surface = (await res.json()) as any;

  const body = await (await app.request(`/s/${surface.id}`)).text();
  assert.match(
    body,
    /<meta property="og:title" content="A &quot;quoted&quot; &lt;tag&gt; &amp; more">/,
  );
  assert.doesNotMatch(body, /content="A "quoted" <tag> & more"/);
});

test("GET /s/:id preview metadata respects configured base path", async () => {
  const app = makeApp(undefined, { basePath: "/u/alice" });
  const res = await app.request("/api/snippets", json({ title: "Base", html: "<p>x</p>" }));
  const surface = (await res.json()) as any;

  const body = await (await app.request(`https://board.test/s/${surface.id}`)).text();
  assert.match(
    body,
    new RegExp(`<link rel="canonical" href="https://board.test/u/alice/s/${surface.id}">`),
  );
  assert.match(
    body,
    new RegExp(
      `<meta property="og:image" content="https://board.test/u/alice/s/${surface.id}\\.png\\?card=1">`,
    ),
  );
  assert.match(body, /window\.__SIDESHOW_BASE_PATH__="\/u\/alice"/);
});

test("/s served versioned + themed is cacheable; an unpinned load is not", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/surfaces",
    json({ title: "C", parts: [{ kind: "code", code: "x", language: "text" }] }),
  );
  const { id, version } = (await res.json()) as any;
  // What the viewer always sends (ver + theme pinned) is immutable → long-cache.
  const pinned = await app.request(`/s/${id}?part=0&ver=${version}&theme=github&mode=light`);
  assert.match(pinned.headers.get("cache-control") ?? "", /immutable/);
  // A bare load resolves to "current", which can change → must not be cached.
  const bare = await app.request(`/s/${id}?part=0`);
  assert.match(bare.headers.get("cache-control") ?? "", /no-cache/);
});

test("a snippet's kits ride the html part and inject the kit CSS/JS at /s", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/snippets",
    json({ title: "Deck", html: "<div class=deck></div>", kits: ["slides"] }),
  );
  assert.equal(res.status, 201);
  const surface = (await res.json()) as any;

  // the kits persist on the stored html part
  const full = (await (await app.request(`/api/surfaces/${surface.id}`)).json()) as any;
  assert.deepEqual(full.surfaces[0].kits, ["slides"]);

  // /s injects the kit's css (rail/deck rules) and its behavior js
  const doc = await (await app.request(`/s/${surface.id}?part=0`)).text();
  assert.match(doc, /\.deck>\.slide/);
  assert.match(doc, /querySelector\('\.deck'\)/);

  // a plain snippet (no kits) gets neither
  const plain = await app.request("/api/snippets", json({ title: "Plain", html: "<p>x</p>" }));
  const plainSurface = (await plain.json()) as any;
  const plainDoc = await (await app.request(`/s/${plainSurface.id}?part=0`)).text();
  assert.doesNotMatch(plainDoc, /querySelector\('\.deck'\)/);
});

test("an unknown kit id is rejected before storage (400)", async () => {
  const app = makeApp();
  const bad = await app.request(
    "/api/snippets",
    json({ title: "x", html: "<p>x</p>", kits: ["bogus"] }),
  );
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as any).error, /unknown kit "bogus"/);

  const badPart = await app.request(
    "/api/surfaces",
    json({ title: "x", parts: [{ kind: "html", html: "<p>x</p>", kits: ["bogus"] }] }),
  );
  assert.equal(badPart.status, 400);
});

test("GET /api/kits advertises the available kits without the css payload", async () => {
  const app = makeApp();
  const kits = (await (await app.request("/api/kits")).json()) as any[];
  const ids = kits.map((k) => k.id);
  assert.ok(ids.includes("issues") && ids.includes("slides"));
  for (const k of kits) {
    assert.ok(typeof k.summary === "string" && k.summary.length > 0);
    assert.equal("css" in k, false);
  }
});

test("REST surface routes reject malformed parts before storage", async () => {
  const app = makeApp();

  const badCreate = await app.request("/api/surfaces", json({ parts: [{ kind: "image" }] }));
  assert.equal(badCreate.status, 400);
  assert.match(((await badCreate.json()) as any).error, /assetId/);
  assert.deepEqual(await (await app.request("/api/sessions")).json(), []);

  const good = (await (
    await app.request("/api/surfaces", json({ parts: [{ kind: "html", html: "<p>x</p>" }] }))
  ).json()) as any;
  const badUpdate = await app.request(`/api/surfaces/${good.id}`, {
    ...json({ parts: [{ kind: "diff", files: [{ filename: "x", before: "a" }] }] }),
    method: "PUT",
  });
  assert.equal(badUpdate.status, 400);
  assert.match(((await badUpdate.json()) as any).error, /before.*after/);

  const unchanged = (await (await app.request(`/api/surfaces/${good.id}`)).json()) as any;
  assert.equal(unchanged.version, 1);
  assert.equal(unchanged.surfaces.length, 1);
  assert.equal(unchanged.surfaces[0].kind, "html");
  assert.equal(unchanged.surfaces[0].html, "<p>x</p>");
});

test("publish_surface MCP tool round-trips a diff part", async () => {
  const app = makeApp();
  const list = (await (await app.request("/mcp", mcpCall(1, "tools/list"))).json()) as any;
  const names = list.result.tools.map((t: any) => t.name);
  assert.ok(names.includes("publish_surface"));
  assert.ok(names.includes("publish_snippet")); // alias still advertised

  const published = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "publish_surface",
        arguments: {
          title: "Diff",
          parts: [{ kind: "diff", patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+y" }],
        },
      }),
    )
  ).json()) as any;
  const payload = JSON.parse(published.result.content[0].text);
  assert.ok(payload.id && payload.sessionId);
  const full = (await (await app.request(`/api/surfaces/${payload.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "diff");
  assert.equal(full.surfaces[0].patch, "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+y");
});

test("publishes a markdown part; /s server-renders it to sandboxed html", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/surfaces",
    json({ title: "Plan", parts: [{ kind: "markdown", markdown: "## Plan\n\n- step one" }] }),
  );
  assert.equal(res.status, 201);
  const surface = (await res.json()) as any;
  assert.deepEqual(surface.kinds, ["markdown"]);

  const full = (await (await app.request(`/api/surfaces/${surface.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "markdown");
  assert.equal(full.surfaces[0].markdown, "## Plan\n\n- step one");
  // markdown now renders server-side: the prose is in the document, and it is
  // served opaque-sandboxed (the load-bearing CSP header).
  const doc = await app.request(`/s/${surface.id}?part=0`);
  assert.equal(doc.status, 200);
  const body = await doc.text();
  assert.ok(body.includes("<h2>Plan</h2>"));
  assert.ok(body.includes("step one"));
  assert.match(doc.headers.get("content-security-policy") ?? "", /\bsandbox\b/);
});

test("publish_surface MCP tool keeps markdown parts and drops empty ones", async () => {
  const app = makeApp();
  const published = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "publish_surface",
        arguments: {
          title: "Notes",
          parts: [
            { kind: "markdown", markdown: "  " },
            { kind: "markdown", markdown: "real prose" },
          ],
        },
      }),
    )
  ).json()) as any;
  const payload = JSON.parse(published.result.content[0].text);
  const full = (await (await app.request(`/api/surfaces/${payload.id}`)).json()) as any;
  assert.equal(full.surfaces.length, 1);
  assert.equal(full.surfaces[0].kind, "markdown");
  assert.equal(full.surfaces[0].markdown, "real prose");
});

test("publish_surface MCP tool round-trips a terminal part", async () => {
  const app = makeApp();
  const published = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "publish_surface",
        arguments: {
          title: "Terminal",
          parts: [
            { kind: "terminal", text: "$ echo hi\n\x1b[32mhi\x1b[0m", cols: 80, title: "sh" },
          ],
        },
      }),
    )
  ).json()) as any;
  const payload = JSON.parse(published.result.content[0].text);
  assert.ok(payload.id && payload.sessionId);
  const full = (await (await app.request(`/api/surfaces/${payload.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "terminal");
  assert.equal(full.surfaces[0].text, "$ echo hi\n\x1b[32mhi\x1b[0m");
  assert.equal(full.surfaces[0].cols, 80);
  assert.equal(full.surfaces[0].title, "sh");
  // terminal now renders server-side (ansi_up → styled window) at /s
  const doc = await app.request(`/s/${payload.id}?part=0`);
  assert.equal(doc.status, 200);
  assert.ok((await doc.text()).includes("term-body"));
});

test("publishes a mermaid part; /s emits a self-rendering CDN doc", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/surfaces",
    json({ title: "Flow", parts: [{ kind: "mermaid", mermaid: "graph TD; A-->B" }] }),
  );
  assert.equal(res.status, 201);
  const surface = (await res.json()) as any;
  assert.deepEqual(surface.kinds, ["mermaid"]);

  const full = (await (await app.request(`/api/surfaces/${surface.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "mermaid");
  assert.equal(full.surfaces[0].mermaid, "graph TD; A-->B");
  // mermaid can't render without a DOM, so /s emits a sandboxed doc that loads
  // mermaid from the CDN and renders the source in-frame. The doc carries the
  // source and the CDN import, and is served opaque-sandboxed.
  const doc = await app.request(`/s/${surface.id}?part=0`);
  assert.equal(doc.status, 200);
  const body = await doc.text();
  assert.ok(body.includes("esm.sh/mermaid"));
  assert.ok(body.includes("graph TD; A--\\u003eB") || body.includes("graph TD; A-->B"));
  assert.match(doc.headers.get("content-security-policy") ?? "", /\bsandbox\b/);
});

test("publishes a json part; round-trips data and 404s on /s", async () => {
  const app = makeApp();
  const data = {
    name: "sideshow",
    version: "1.2.3",
    deps: ["a", "b"],
    nested: { x: true, y: null },
  };
  const res = await app.request(
    "/api/surfaces",
    json({ title: "Config", parts: [{ kind: "json", data }] }),
  );
  assert.equal(res.status, 201);
  const surface = (await res.json()) as any;
  assert.deepEqual(surface.kinds, ["json"]);

  const full = (await (await app.request(`/api/surfaces/${surface.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "json");
  assert.deepEqual(full.surfaces[0].data, data);
  // json is viewer-rendered data, not a sandboxed html doc
  assert.equal((await app.request(`/s/${surface.id}?part=0`)).status, 404);
});

test("json part with null data is valid (null is a JSON value)", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/surfaces",
    json({ title: "Null", parts: [{ kind: "json", data: null }] }),
  );
  assert.equal(res.status, 201);
  const surface = (await res.json()) as any;
  const full = (await (await app.request(`/api/surfaces/${surface.id}`)).json()) as any;
  assert.equal(full.surfaces[0].data, null);
});

test("json part without data key is rejected", async () => {
  const app = makeApp();
  const res = await app.request("/api/surfaces", json({ title: "Bad", parts: [{ kind: "json" }] }));
  assert.equal(res.status, 400);
});

test("publishes a code part; round-trips code/lang/title and 404s on /s", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/surfaces",
    json({
      title: "Entry",
      parts: [{ kind: "code", code: "const x = 42;\n", language: "ts", title: "a.ts" }],
    }),
  );
  assert.equal(res.status, 201);
  const surface = (await res.json()) as any;
  assert.deepEqual(surface.kinds, ["code"]);

  const full = (await (await app.request(`/api/surfaces/${surface.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "code");
  assert.equal(full.surfaces[0].code, "const x = 42;\n");
  assert.equal(full.surfaces[0].language, "ts");
  assert.equal(full.surfaces[0].title, "a.ts");
  // code now renders server-side (shiki) at /s, with the filename and copy button
  const doc = await app.request(`/s/${surface.id}?part=0`);
  assert.equal(doc.status, 200);
  const body = await doc.text();
  assert.ok(body.includes("shiki"));
  assert.ok(body.includes("a.ts"));
});

test("code part without code is rejected", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/surfaces",
    json({ title: "Bad", parts: [{ kind: "code", language: "ts" }] }),
  );
  assert.equal(res.status, 400);
});

test("code part with lineStart round-trips", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/surfaces",
    json({
      title: "Excerpt",
      parts: [
        {
          kind: "code",
          code: "const x = 1;\nconst y = 2;\n",
          language: "ts",
          title: "a.ts",
          lineStart: 80,
        },
      ],
    }),
  );
  assert.equal(res.status, 201);
  const surface = (await res.json()) as any;
  const full = (await (await app.request(`/api/surfaces/${surface.id}`)).json()) as any;
  assert.equal(full.surfaces[0].lineStart, 80);
});

test("publish_surface MCP tool keeps mermaid parts and drops empty ones", async () => {
  const app = makeApp();
  const published = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "publish_surface",
        arguments: {
          title: "Diagram",
          parts: [
            { kind: "mermaid", mermaid: "  " },
            { kind: "mermaid", mermaid: "graph TD; A-->B" },
          ],
        },
      }),
    )
  ).json()) as any;
  const payload = JSON.parse(published.result.content[0].text);
  const full = (await (await app.request(`/api/surfaces/${payload.id}`)).json()) as any;
  assert.equal(full.surfaces.length, 1);
  assert.equal(full.surfaces[0].kind, "mermaid");
  assert.equal(full.surfaces[0].mermaid, "graph TD; A-->B");
});

test("update bumps version and keeps history; old version renderable", async () => {
  const app = makeApp();
  const s = (await (
    await app.request("/api/snippets", json({ html: "<p>v1</p>", title: "T" }))
  ).json()) as any;
  const res = await app.request(`/api/snippets/${s.id}`, {
    ...json({ html: "<p>v2</p>" }),
    method: "PUT",
  });
  const updated = (await res.json()) as any;
  assert.equal(updated.version, 2);

  const full = (await (await app.request(`/api/snippets/${s.id}`)).json()) as any;
  assert.equal(full.history.length, 1);
  assert.equal(full.history[0].surfaces[0].html, "<p>v1</p>");

  const current = await (await app.request(`/s/${s.id}?part=0`)).text();
  assert.ok(current.includes("<p>v2</p>"));
  const old = await (await app.request(`/s/${s.id}?part=0&ver=1`)).text();
  assert.ok(old.includes("<p>v1</p>"));
});

test("snippet page is wrapped with CSP, bridge, and kit", async () => {
  const app = makeApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  const page = await (await app.request(`/s/${s.id}?part=0`)).text();
  assert.ok(page.includes("Content-Security-Policy"));
  assert.ok(page.includes("window.sendPrompt"));
  assert.ok(page.includes("__sideshow"));
  // Snippet kit: SVG utilities in the stylesheet and the shared arrow marker
  // injected before the snippet body so url(#arrow) resolves.
  assert.ok(page.includes(".c-blue"));
  assert.ok(page.indexOf('<marker id="arrow"') < page.indexOf("<p>x</p>"));
  assert.ok(page.includes('<marker id="arrow"'));
});

test("comments attach to snippets and filter by author/after", async () => {
  const app = makeApp();
  const s = (await (
    await app.request("/api/snippets", json({ html: "<p>x</p>", title: "Sketch" }))
  ).json()) as any;
  await app.request("/api/comments", json({ snippet: s.id, text: "love it", author: "user" }));
  await app.request("/api/comments", json({ snippet: s.id, text: "thanks", author: "claude" }));

  const all = (await (await app.request(`/api/comments?session=${s.sessionId}`)).json()) as any;
  assert.equal(all.comments.length, 2);
  assert.equal(all.comments[0].postTitle, "Sketch");

  // explicit after=0: re-read from the start regardless of the agent cursor
  const users = (await (
    await app.request(`/api/comments?session=${s.sessionId}&author=user&after=0`)
  ).json()) as any;
  assert.equal(users.comments.length, 1);
  assert.equal(users.comments[0].text, "love it");

  const later = (await (
    await app.request(`/api/comments?session=${s.sessionId}&after=${all.lastSeq}`)
  ).json()) as any;
  assert.equal(later.comments.length, 0);
});

test("a comment must target a surface", async () => {
  const app = makeApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;

  // no surface/snippet id — there is no session-level thread to land in
  const res = await app.request("/api/comments", json({ session: s.sessionId, text: "general" }));
  assert.equal(res.status, 400);

  // a surface that doesn't exist is a 404, not a silent session-level comment
  const ghost = await app.request("/api/comments", json({ snippet: "missing", text: "ghost" }));
  assert.equal(ghost.status, 404);
});

test("author=user reads resume from the agent's server-side cursor", async () => {
  const app = makeApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  await app.request("/api/comments", json({ snippet: s.id, text: "first", author: "user" }));

  // no cursor given: delivered once...
  const first = (await (
    await app.request(`/api/comments?session=${s.sessionId}&author=user`)
  ).json()) as any;
  assert.equal(first.comments.length, 1);
  assert.equal(first.comments[0].text, "first");

  // ...and not again on the next cursor-less read (e.g. a fresh CLI process)
  const again = (await (
    await app.request(`/api/comments?session=${s.sessionId}&author=user`)
  ).json()) as any;
  assert.equal(again.comments.length, 0);

  // unfiltered reads (the viewer) never consume the cursor
  const viewer = (await (await app.request(`/api/comments?session=${s.sessionId}`)).json()) as any;
  assert.equal(viewer.comments.length, 1);
});

test("piggyback delivery advances the cursor seen by author=user waits", async () => {
  const app = makeApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  await app.request("/api/comments", json({ snippet: s.id, text: "tweak it", author: "user" }));

  // an agent write piggybacks the pending feedback...
  const updated = (await (
    await app.request(`/api/snippets/${s.id}`, {
      ...json({ html: "<p>v2</p>" }),
      method: "PUT",
    })
  ).json()) as any;
  assert.equal(updated.userFeedback.length, 1);
  assert.equal(updated.userFeedback[0].text, "tweak it");

  // ...so a cursor-less wait on another channel must not re-deliver it
  const wait = (await (
    await app.request(`/api/comments?session=${s.sessionId}&author=user`)
  ).json()) as any;
  assert.equal(wait.comments.length, 0);
});

test("author=user lastSeq reflects the last comment overall, not the last user comment", async () => {
  // When an agent reply lands after the user comment, the cursor returned
  // to the caller (lastSeq) must be the agent comment's seq — otherwise
  // the next call re-reads the agent comment and wastes a round-trip.
  const app = makeApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  await app.request("/api/comments", json({ snippet: s.id, text: "first", author: "user" }));
  await app.request("/api/comments", json({ snippet: s.id, text: "reply", author: "agent" }));

  const res = (await (
    await app.request(`/api/comments?session=${s.sessionId}&author=user&after=0`)
  ).json()) as any;
  assert.equal(res.comments.length, 1);
  assert.equal(res.comments[0].text, "first");
  // lastSeq is the agent comment's seq (2), not the user comment's (1)
  assert.equal(res.lastSeq, 2);
});

function makeVersionApp(version?: string, latest?: { version: string; notes?: string } | Error) {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-test-"));
  return createApp({
    store: new JsonFileStore(join(dir, "data.json")),
    viewerHtml: "<html>viewer</html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    agentHowtoText: "# agent how-to",
    version,
    upgradeCommand: "npm install -g sideshow",
    fetchLatestRelease: () =>
      latest instanceof Error ? Promise.reject(latest) : Promise.resolve(latest ?? null),
  });
}

test("version endpoint reports an available update with notes", async () => {
  const app = makeVersionApp("0.3.0", { version: "0.4.0", notes: "### Added\n- things" });
  const res = (await (await app.request("/api/version")).json()) as any;
  assert.deepEqual(res, {
    current: "0.3.0",
    latest: "0.4.0",
    updateAvailable: true,
    upgradeCommand: "npm install -g sideshow",
    notes: "### Added\n- things",
  });
});

test("version endpoint is quiet when current, unconfigured, or offline", async () => {
  // up to date — and a same-or-older registry version is never an "update"
  const same = (await (
    await makeVersionApp("0.4.0", { version: "0.4.0" }).request("/api/version")
  ).json()) as any;
  assert.equal(same.updateAvailable, false);
  assert.equal(same.upgradeCommand, null);
  const older = (await (
    await makeVersionApp("0.4.1", { version: "0.4.0" }).request("/api/version")
  ).json()) as any;
  assert.equal(older.updateAvailable, false);

  // no version configured: nothing to compare against
  const none = (await (await makeVersionApp(undefined).request("/api/version")).json()) as any;
  assert.deepEqual(none, { current: null, latest: null, updateAvailable: false });

  // lookup failure is silent
  const offline = (await (
    await makeVersionApp("0.3.0", new Error("offline")).request("/api/version")
  ).json()) as any;
  assert.deepEqual(offline, {
    current: "0.3.0",
    latest: null,
    updateAvailable: false,
    upgradeCommand: null,
    notes: null,
  });
});

test("long-poll resolves when a comment arrives", async () => {
  const app = makeApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  const pending = app.request(`/api/comments?session=${s.sessionId}&wait=5`);
  setTimeout(() => {
    app.request("/api/comments", json({ snippet: s.id, text: "feedback!", author: "user" }));
  }, 50);
  const start = Date.now();
  const result = (await (await pending).json()) as any;
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].text, "feedback!");
  assert.ok(Date.now() - start < 4000, "should resolve well before the timeout");
});

// --- connection caps (SSE + long-poll share one per-instance bound) ---

test("SSE connections are capped; a released slot lets a new one in", async () => {
  const app = makeApp(undefined, { maxHoldConnections: 2 });
  const controllers = [new AbortController(), new AbortController()];
  // Two streams fill the cap. The slot is acquired before streamSSE opens, so
  // merely having the Response back means it's held — no body read needed.
  const streams = await Promise.all(
    controllers.map((ac) => app.request("/api/events", { signal: ac.signal })),
  );
  assert.ok(streams.every((s) => s.status === 200));
  // A third is rejected.
  assert.equal((await app.request("/api/events")).status, 503);
  // Releasing one frees a slot for a fresh stream.
  controllers[0].abort();
  await streams[0].body!.cancel().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const again = await app.request("/api/events", { signal: new AbortController().signal });
  assert.equal(again.status, 200);
  // cleanup
  controllers[1].abort();
  await streams[1].body!.cancel().catch(() => undefined);
  await again.body!.cancel().catch(() => undefined);
});

test("long-poll waits count against the hold cap; instant reads do not", async () => {
  const app = makeApp(undefined, { maxHoldConnections: 2 });
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  // Two held long-polls fill the cap; they resolve when a comment lands.
  const pending = [
    app.request(`/api/comments?session=${s.sessionId}&wait=5`),
    app.request(`/api/comments?session=${s.sessionId}&wait=5`),
  ];
  await new Promise((resolve) => setTimeout(resolve, 30));
  // A third held wait is rejected.
  assert.equal((await app.request(`/api/comments?session=${s.sessionId}&wait=5`)).status, 503);
  // An instant (?wait=0) read is not a held connection — still served at cap.
  assert.equal((await app.request(`/api/comments?session=${s.sessionId}`)).status, 200);
  // Post a comment so both held waits resolve and release their slots.
  await app.request("/api/comments", json({ snippet: s.id, text: "release" }));
  const resolved = await Promise.all(pending);
  assert.ok(resolved.every((r) => r.status === 200));
});

test("SSE and long-poll share the same connection budget", async () => {
  const app = makeApp(undefined, { maxHoldConnections: 2 });
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  // One SSE + one long-poll fills the shared cap.
  const sse = await app.request("/api/events", { signal: new AbortController().signal });
  assert.equal(sse.status, 200);
  const poll = app.request(`/api/comments?session=${s.sessionId}&wait=5`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Neither a second SSE nor a second long-poll fits.
  assert.equal((await app.request("/api/events")).status, 503);
  assert.equal((await app.request(`/api/comments?session=${s.sessionId}&wait=5`)).status, 503);
  // Releasing the long-poll (comment lands) frees a slot for SSE again.
  await app.request("/api/comments", json({ snippet: s.id, text: "release" }));
  await poll;
  const sseAgain = await app.request("/api/events", { signal: new AbortController().signal });
  assert.equal(sseAgain.status, 200);
  // cleanup
  await sse.body!.cancel().catch(() => undefined);
  await sseAgain.body!.cancel().catch(() => undefined);
});

test("deleting a session cascades to snippets and comments", async () => {
  const app = makeApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  await app.request("/api/comments", json({ snippet: s.id, text: "hi" }));
  const res = await app.request(`/api/sessions/${s.sessionId}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal((await app.request(`/api/snippets/${s.id}`)).status, 404);
  const sessions = (await (await app.request("/api/sessions")).json()) as any;
  assert.equal(sessions.length, 0);
});

test("rename session", async () => {
  const app = makeApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  const res = await app.request(`/api/sessions/${s.sessionId}`, {
    ...json({ title: "Auth refactor" }),
    method: "PATCH",
  });
  assert.equal(((await res.json()) as any).title, "Auth refactor");
});

test("auth hook can guard an embedding host without authToken", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-test-"));
  const app = createApp({
    store: new JsonFileStore(join(dir, "data.json")),
    viewerHtml: "<html>viewer</html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    authenticate: (request) => request.headers.get("x-sideshow-internal") === "ok",
  });

  assert.equal((await app.request("/guide")).status, 401);
  assert.equal((await app.request("/api/sessions")).status, 401);
  const allowed = await app.request("/api/sessions", { headers: { "x-sideshow-internal": "ok" } });
  assert.equal(allowed.status, 200);
});

test("auth token guards mutating routes when configured", async () => {
  const app = makeApp("secret");
  const denied = await app.request("/api/snippets", json({ html: "<p>x</p>" }));
  assert.equal(denied.status, 401);
  const allowed = await app.request("/api/snippets", authedJson({ html: "<p>x</p>" }));
  assert.equal(allowed.status, 201);
  // full surface is guarded, including reads and the viewer
  assert.equal((await app.request("/api/sessions")).status, 401);
  assert.equal((await app.request("/")).status, 401);
  // docs and bootstrap instructions stay open
  assert.equal((await app.request("/guide")).status, 200);
  assert.equal((await app.request("/setup")).status, 200);
  assert.equal((await app.request("/agent-howto")).status, 200);
  // ?key= grants access and sets a cookie for subsequent requests
  const keyed = await app.request("/?key=secret");
  assert.equal(keyed.status, 200);
  const cookie = keyed.headers.get("set-cookie") ?? "";
  assert.ok(cookie.includes("sideshow_key=secret"));
  const viaCookie = await app.request("/api/sessions", {
    headers: { cookie: "sideshow_key=secret" },
  });
  assert.equal(viaCookie.status, 200);
});

async function readSseUntil(res: Response, needle: string, abort?: () => void): Promise<string> {
  assert.ok(res.body);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    await Promise.race([
      (async () => {
        while (!text.includes(needle)) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
      })(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), 1000),
      ),
    ]);
  } finally {
    abort?.();
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

// --- public read auth modes ---

test("public read full mode allows unauthenticated GETs but not writes", async () => {
  const app = makeApp("secret", { publicRead: "full" });

  assert.equal((await app.request("/")).status, 200);
  assert.equal((await app.request("/session/anything")).status, 200);
  assert.equal((await app.request("/api/sessions")).status, 200);
  assert.equal((await app.request("/api/theme")).status, 200);
  assert.equal((await app.request("/api/version")).status, 200);

  const created = (await (
    await app.request("/api/snippets", authedJson({ html: "<p>x</p>" }))
  ).json()) as any;
  assert.equal((await app.request(`/s/${created.id}`)).status, 200);
  assert.equal((await app.request(`/api/surfaces/${created.id}`)).status, 200);

  assert.equal((await app.request("/api/snippets", json({ html: "<p>x</p>" }))).status, 401);
  assert.equal((await app.request("/api/comments", json({ text: "hi" }))).status, 401);
});

test("public read session mode allows scoped reads and denies root/session list", async () => {
  const app = makeApp("secret", { publicRead: "session" });

  assert.equal((await app.request("/")).status, 401);
  assert.equal((await app.request("/api/sessions")).status, 401);
  assert.equal((await app.request("/api/theme")).status, 200);
  assert.equal((await app.request("/api/version")).status, 200);

  const created = (await (
    await app.request("/api/snippets", authedJson({ html: "<p>x</p>" }))
  ).json()) as any;
  assert.equal((await app.request(`/session/${created.sessionId}`)).status, 200);
  assert.equal((await app.request(`/session/${created.sessionId}/s/${created.id}`)).status, 200);
  assert.equal((await app.request(`/s/${created.id}`)).status, 200);
  assert.equal((await app.request(`/api/surfaces/${created.id}`)).status, 200);
  assert.equal((await app.request(`/api/snippets/${created.id}`)).status, 200);
  assert.equal((await app.request(`/api/sessions/${created.sessionId}/surfaces`)).status, 200);

  assert.equal((await app.request("/api/snippets", json({ html: "<p>x</p>" }))).status, 401);
});

test("public read session mode validates unauthenticated session viewer URLs", async () => {
  const app = makeApp("secret", { publicRead: "session" });
  const created = (await (
    await app.request("/api/snippets", authedJson({ html: "<p>x</p>" }))
  ).json()) as any;

  assert.equal((await app.request("/session/missing")).status, 404);
  assert.equal((await app.request(`/session/${created.sessionId}/s/missing`)).status, 404);
  assert.equal((await app.request(`/session/missing/s/${created.id}`)).status, 404);

  const authed = await app.request("/session/missing", {
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(authed.status, 200);
});

test("public read session mode protects unscoped comments reads", async () => {
  const app = makeApp("secret", { publicRead: "session" });
  const created = (await (
    await app.request("/api/snippets", authedJson({ html: "<p>x</p>" }))
  ).json()) as any;
  await app.request("/api/comments", authedJson({ snippet: created.id, text: "hi" }));

  assert.equal((await app.request("/api/comments")).status, 401);
  assert.equal((await app.request("/api/comments?session=missing")).status, 404);
  assert.equal((await app.request(`/api/comments?session=${created.sessionId}`)).status, 200);
  assert.equal((await app.request(`/api/comments?surface=${created.id}`)).status, 200);

  const owner = await app.request("/api/comments", {
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(owner.status, 200);
});

test("public read session mode protects and scopes event streams", async () => {
  const app = makeApp("secret", { publicRead: "session" });
  const first = (await (
    await app.request("/api/snippets", authedJson({ html: "<p>one</p>" }))
  ).json()) as any;
  const second = (await (
    await app.request("/api/snippets", authedJson({ html: "<p>two</p>" }))
  ).json()) as any;

  assert.equal((await app.request("/api/events")).status, 401);
  assert.equal((await app.request("/api/events?session=missing")).status, 404);

  const ac = new AbortController();
  const stream = await app.request(`/api/events?session=${first.sessionId}`, { signal: ac.signal });
  assert.equal(stream.status, 200);
  const other = (await (
    await app.request(
      "/api/snippets",
      authedJson({ html: "<p>other</p>", session: second.sessionId }),
    )
  ).json()) as any;
  const matching = (await (
    await app.request(
      "/api/snippets",
      authedJson({ html: "<p>matching</p>", session: first.sessionId }),
    )
  ).json()) as any;

  const text = await readSseUntil(stream, matching.id, () => ac.abort());
  assert.ok(text.includes(matching.id));
  assert.ok(!text.includes(other.id));
});

test("public read viewer config marks unauthenticated full-mode visitors readonly", async () => {
  const app = makeApp("secret", { publicRead: "full" });

  const html = await (await app.request("/")).text();
  assert.ok(html.includes("__SIDESHOW_READONLY__=true"));
  assert.ok(html.includes('__SIDESHOW_PUBLIC_READ__="full"'));
});

test("public read viewer config keeps authenticated owners writable", async () => {
  const app = makeApp("secret", { publicRead: "full" });

  const html = await (
    await app.request("/", { headers: { authorization: "Bearer secret" } })
  ).text();
  assert.ok(!html.includes("__SIDESHOW_READONLY__"));
  assert.ok(!html.includes("__SIDESHOW_PUBLIC_READ__"));
});

test("public read viewer config marks session-mode visitors readonly", async () => {
  const app = makeApp("secret", { publicRead: "session" });
  const created = (await (
    await app.request("/api/snippets", authedJson({ html: "<p>x</p>" }))
  ).json()) as any;

  const html = await (await app.request(`/session/${created.sessionId}`)).text();
  assert.ok(html.includes("__SIDESHOW_READONLY__=true"));
  assert.ok(html.includes('__SIDESHOW_PUBLIC_READ__="session"'));
});

test("viewer config enables screenshots when the deployment supports them", async () => {
  const app = makeApp("secret", { screenshots: true });

  const html = await (
    await app.request("/", { headers: { authorization: "Bearer secret" } })
  ).text();
  assert.ok(html.includes("__SIDESHOW_SCREENSHOTS__=true"));
});

test("viewer config omits the screenshots flag by default (Node server)", async () => {
  const app = makeApp("secret");

  const html = await (
    await app.request("/", { headers: { authorization: "Bearer secret" } })
  ).text();
  assert.ok(!html.includes("__SIDESHOW_SCREENSHOTS__"));
});

test("public read viewer config treats query key as authenticated for that response", async () => {
  const app = makeApp("secret", { publicRead: "full" });

  const res = await app.request("/?key=secret");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes("__SIDESHOW_READONLY__"));
  assert.ok(!html.includes("__SIDESHOW_PUBLIC_READ__"));
});

test("public read does not bypass custom authenticate hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-test-"));
  const app = createApp({
    store: new JsonFileStore(join(dir, "data.json")),
    viewerHtml: "<html>viewer</html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    authenticate: (request) => request.headers.get("x-sideshow-internal") === "ok",
    publicRead: "full",
  });

  assert.equal((await app.request("/api/sessions")).status, 401);
  assert.equal(
    (await app.request("/api/sessions", { headers: { "x-sideshow-internal": "ok" } })).status,
    200,
  );
});

const mcpCall = (id: number, method: string, params?: unknown) =>
  json({ jsonrpc: "2.0", id, method, params });

test("mcp endpoint: initialize, tools/list, publish round trip", async () => {
  const app = makeApp();

  const init = (await (
    await app.request("/mcp", mcpCall(1, "initialize", { protocolVersion: "2025-03-26" }))
  ).json()) as any;
  assert.equal(init.result.serverInfo.name, "sideshow");
  assert.ok(init.result.instructions.length > 0);

  const list = (await (await app.request("/mcp", mcpCall(2, "tools/list"))).json()) as any;
  const names = list.result.tools.map((t: any) => t.name);
  assert.ok(names.includes("publish_snippet"));
  assert.ok(names.includes("wait_for_feedback"));

  const published = (await (
    await app.request(
      "/mcp",
      mcpCall(3, "tools/call", {
        name: "publish_snippet",
        arguments: { title: "Via MCP", html: "<p>mcp</p>", agent: "test-agent" },
      }),
    )
  ).json()) as any;
  const payload = JSON.parse(published.result.content[0].text);
  assert.ok(payload.id);
  assert.ok(payload.sessionId);
  assert.ok(payload.url.includes(`/s/${payload.id}`));

  // session continuity: second publish into the returned session
  const second = (await (
    await app.request(
      "/mcp",
      mcpCall(4, "tools/call", {
        name: "publish_snippet",
        arguments: { title: "Second", html: "<p>2</p>", session: payload.sessionId },
      }),
    )
  ).json()) as any;
  assert.equal(JSON.parse(second.result.content[0].text).sessionId, payload.sessionId);

  // feedback loop through the mcp tool
  await app.request("/api/comments", json({ snippet: payload.id, text: "nice", author: "user" }));
  const feedback = (await (
    await app.request(
      "/mcp",
      mcpCall(5, "tools/call", {
        name: "wait_for_feedback",
        arguments: { session: payload.sessionId, timeoutSeconds: 0 },
      }),
    )
  ).json()) as any;
  const fb = JSON.parse(feedback.result.content[0].text);
  assert.equal(fb.comments.length, 1);
  assert.equal(fb.comments[0].text, "nice");
  assert.ok(fb.lastSeq > 0);
});

test("mcp publish_snippet honors sessionTitle on first publish only", async () => {
  const app = makeApp();
  const published = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", {
        name: "publish_snippet",
        arguments: { title: "One", html: "<p>1</p>", sessionTitle: "Cache design" },
      }),
    )
  ).json()) as any;
  const payload = JSON.parse(published.result.content[0].text);
  const sessions = (await (await app.request("/api/sessions")).json()) as any;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "Cache design");

  // publishing into the existing session with another sessionTitle is a no-op
  await app.request(
    "/mcp",
    mcpCall(2, "tools/call", {
      name: "publish_snippet",
      arguments: {
        title: "Two",
        html: "<p>2</p>",
        session: payload.sessionId,
        sessionTitle: "Other",
      },
    }),
  );
  const after = (await (await app.request("/api/sessions")).json()) as any;
  assert.equal(after[0].title, "Cache design");
});

test("mcp endpoint: unknown method and unknown tool", async () => {
  const app = makeApp();
  const bad = (await (await app.request("/mcp", mcpCall(1, "resources/list"))).json()) as any;
  assert.equal(bad.error.code, -32601);
  const badTool = (await (
    await app.request("/mcp", mcpCall(2, "tools/call", { name: "nope", arguments: {} }))
  ).json()) as any;
  assert.equal(badTool.result.isError, true);
});

test("mcp endpoint requires bearer when token configured", async () => {
  const app = makeApp("secret");
  assert.equal((await app.request("/mcp", mcpCall(1, "tools/list"))).status, 401);
  const ok = await app.request("/mcp", {
    ...mcpCall(2, "tools/list"),
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
  });
  assert.equal(ok.status, 200);
});

test("mcp upload_asset stores base64 bytes and returns id + url + kind", async () => {
  const app = makeApp();
  const data = Buffer.from("\x89PNG\r\n\x1a\n pixels");
  const res = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", {
        name: "upload_asset",
        arguments: {
          data: data.toString("base64"),
          contentType: "image/png",
          filename: "shot.png",
          kind: "image",
        },
      }),
    )
  ).json()) as any;
  assert.equal(res.result.isError, undefined);
  const asset = JSON.parse(res.result.content[0].text);
  assert.ok(asset.id);
  assert.equal(asset.kind, "image");
  assert.equal(asset.contentType, "image/png");
  assert.equal(asset.byteLength, data.length);
  assert.ok(asset.url.includes(`/a/${asset.id}`));
  // the blob is retrievable at the asset route, with matching bytes
  const blob = await app.request(`/a/${asset.id}`);
  assert.equal(blob.status, 200);
  assert.equal((await blob.arrayBuffer()).byteLength, data.length);
});

test("mcp upload_asset without data fails with a clear error", async () => {
  const app = makeApp();
  const res = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", { name: "upload_asset", arguments: { contentType: "image/png" } }),
    )
  ).json()) as any;
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /upload_asset needs base64 `data`/);
});

test("mcp upload_asset with an explicit session attaches the asset to it", async () => {
  const app = makeApp();
  const session = (await (await app.request("/api/sessions", json({ agent: "m" }))).json()) as any;
  const res = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", {
        name: "upload_asset",
        arguments: {
          data: Buffer.from("hi").toString("base64"),
          contentType: "text/plain",
          session: session.id,
        },
      }),
    )
  ).json()) as any;
  const asset = JSON.parse(res.result.content[0].text);
  assert.equal(asset.sessionId, session.id);
});

test("mcp get_design_guide returns the guide text", async () => {
  const app = makeApp();
  const res = (await (
    await app.request("/mcp", mcpCall(1, "tools/call", { name: "get_design_guide", arguments: {} }))
  ).json()) as any;
  assert.equal(res.result.isError, undefined);
  assert.equal(res.result.content[0].text, "# guide");
});

test("mcp publish_post with no surfaces fails with a clear error", async () => {
  const app = makeApp();
  const res = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", { name: "publish_post", arguments: { surfaces: [] } }),
    )
  ).json()) as any;
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /a post needs at least one surface/);
});

test("mcp update_snippet revises via the legacy html argument", async () => {
  const app = makeApp();
  const pub = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", { name: "publish_snippet", arguments: { html: "<p>v1</p>" } }),
    )
  ).json()) as any;
  const id = JSON.parse(pub.result.content[0].text).id;
  const res = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", { name: "update_snippet", arguments: { id, html: "<p>v2</p>" } }),
    )
  ).json()) as any;
  const out = JSON.parse(res.result.content[0].text);
  assert.equal(out.id, id);
  assert.equal(out.version, 2);
});

test("mcp endpoint: malformed JSON body is a -32700 parse error", async () => {
  const app = makeApp();
  const res = await app.request("/mcp", { method: "POST", body: "{not valid json" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, -32700);
  assert.equal(body.id, null);
});

test("mcp endpoint: a JSON-RPC batch is rejected with -32600", async () => {
  const app = makeApp();
  const res = await app.request("/mcp", json([mcpCall(1, "tools/list").body]));
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, -32600);
  assert.match(body.error.message, /batch/);
});

test("mcp endpoint: a notification (no id) is acknowledged 202 with no body", async () => {
  const app = makeApp();
  const res = await app.request(
    "/mcp",
    json({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  assert.equal(res.status, 202);
});

test("mcp endpoint: ping responds with an empty result", async () => {
  const app = makeApp();
  const res = (await (await app.request("/mcp", mcpCall(1, "ping"))).json()) as any;
  assert.deepEqual(res.result, {});
});

test("agent writes piggyback unseen user comments, delivered once", async () => {
  const app = makeApp();
  const s = (await (
    await app.request("/api/snippets", json({ html: "<p>v1</p>", title: "Doc" }))
  ).json()) as any;
  assert.equal(s.userFeedback, undefined);

  // the user comments while the agent works on something else
  await app.request("/api/comments", json({ snippet: s.id, text: "wrong color", author: "user" }));
  await app.request("/api/comments", json({ snippet: s.id, text: "also add a key" }));

  // the agent's next write carries the feedback
  const updated = (await (
    await app.request(`/api/snippets/${s.id}`, { ...json({ html: "<p>v2</p>" }), method: "PUT" })
  ).json()) as any;
  assert.deepEqual(
    updated.userFeedback.map((f: any) => f.text),
    ["wrong color", "also add a key"],
  );
  assert.equal(updated.userFeedback[0].surfaceTitle, "Doc");

  // delivered once — the next write is clean
  const again = (await (
    await app.request(`/api/snippets/${s.id}`, { ...json({ html: "<p>v3</p>" }), method: "PUT" })
  ).json()) as any;
  assert.equal(again.userFeedback, undefined);

  // agent replies piggyback too; the user's own comments never do
  await app.request("/api/comments", json({ snippet: s.id, text: "more", author: "user" }));
  const userPost = (await (
    await app.request("/api/comments", json({ snippet: s.id, text: "and more", author: "user" }))
  ).json()) as any;
  assert.equal(userPost.userFeedback, undefined);
  const reply = (await (
    await app.request("/api/comments", json({ snippet: s.id, text: "on it", author: "claude" }))
  ).json()) as any;
  assert.deepEqual(
    reply.userFeedback.map((f: any) => f.text),
    ["more", "and more"],
  );
});

test("a consumed wait is not re-delivered as piggyback", async () => {
  const app = makeApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  await app.request(
    "/api/comments",
    json({ snippet: s.id, text: "seen via wait", author: "user" }),
  );

  // the agent receives it through the long-poll...
  const waited = (await (
    await app.request(`/api/comments?session=${s.sessionId}&author=user`)
  ).json()) as any;
  assert.equal(waited.comments.length, 1);

  // ...so the next write carries nothing
  const updated = (await (
    await app.request(`/api/snippets/${s.id}`, { ...json({ html: "<p>v2</p>" }), method: "PUT" })
  ).json()) as any;
  assert.equal(updated.userFeedback, undefined);

  // the viewer's unfiltered reads do NOT consume the cursor
  await app.request("/api/comments", json({ snippet: s.id, text: "fresh", author: "user" }));
  await app.request(`/api/comments?session=${s.sessionId}`); // viewer-style read
  const next = (await (
    await app.request(`/api/snippets/${s.id}`, { ...json({ html: "<p>v3</p>" }), method: "PUT" })
  ).json()) as any;
  assert.deepEqual(
    next.userFeedback.map((f: any) => f.text),
    ["fresh"],
  );
});

// The agentSeq cursor is shared across every delivery channel, so a comment
// delivered once on one channel must never reappear on another. The REST-to-REST
// directions are covered above; these pin the MCP<->REST crossings, the pairing
// most likely to drift since the two go through different code paths.

test("feedback consumed via the MCP wait is not re-delivered through REST channels", async () => {
  const app = makeApp();
  const published = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", {
        name: "publish_snippet",
        arguments: { title: "Doc", html: "<p>v1</p>", agent: "mcp-agent" },
      }),
    )
  ).json()) as any;
  const p = JSON.parse(published.result.content[0].text);
  await app.request("/api/comments", json({ snippet: p.id, text: "via mcp", author: "user" }));

  // the agent drains it through the MCP tool...
  const feedback = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "wait_for_feedback",
        arguments: { session: p.sessionId, timeoutSeconds: 0 },
      }),
    )
  ).json()) as any;
  assert.deepEqual(
    JSON.parse(feedback.result.content[0].text).comments.map((c: any) => c.text),
    ["via mcp"],
  );

  // ...so a REST write must not re-piggyback it, and a REST author=user read
  // (CLI watch) sees nothing either — both honor the same advanced cursor
  const updated = (await (
    await app.request(`/api/snippets/${p.id}`, { ...json({ html: "<p>v2</p>" }), method: "PUT" })
  ).json()) as any;
  assert.equal(updated.userFeedback, undefined);
  const restWait = (await (
    await app.request(`/api/comments?session=${p.sessionId}&author=user`)
  ).json()) as any;
  assert.equal(restWait.comments.length, 0);
});

test("feedback consumed via a REST wait is not re-delivered through the MCP wait", async () => {
  const app = makeApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  await app.request("/api/comments", json({ snippet: s.id, text: "via rest", author: "user" }));

  // the agent drains it through a REST author=user read...
  const restWait = (await (
    await app.request(`/api/comments?session=${s.sessionId}&author=user`)
  ).json()) as any;
  assert.deepEqual(
    restWait.comments.map((c: any) => c.text),
    ["via rest"],
  );

  // ...so the MCP tool, reading the same cursor, must not re-deliver it
  const feedback = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", {
        name: "wait_for_feedback",
        arguments: { session: s.sessionId, timeoutSeconds: 0 },
      }),
    )
  ).json()) as any;
  const fb = JSON.parse(feedback.result.content[0].text);
  assert.equal(fb.comments.length, 0);

  // and a fresh comment still flows to the MCP channel — the cursor advanced,
  // it didn't wedge
  await app.request("/api/comments", json({ snippet: s.id, text: "later", author: "user" }));
  const next = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "wait_for_feedback",
        arguments: { session: s.sessionId, timeoutSeconds: 0 },
      }),
    )
  ).json()) as any;
  assert.deepEqual(
    JSON.parse(next.result.content[0].text).comments.map((c: any) => c.text),
    ["later"],
  );
});

test("mcp publish result carries userFeedback", async () => {
  const app = makeApp();
  const published = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", {
        name: "publish_snippet",
        arguments: { title: "One", html: "<p>1</p>", agent: "mcp-agent" },
      }),
    )
  ).json()) as any;
  const first = JSON.parse(published.result.content[0].text);
  await app.request("/api/comments", json({ snippet: first.id, text: "neat", author: "user" }));

  const second = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "publish_snippet",
        arguments: { title: "Two", html: "<p>2</p>", session: first.sessionId },
      }),
    )
  ).json()) as any;
  const payload = JSON.parse(second.result.content[0].text);
  assert.deepEqual(
    payload.userFeedback.map((f: any) => f.text),
    ["neat"],
  );
});

test("rejects empty and oversized html", async () => {
  const app = makeApp();
  assert.equal((await app.request("/api/snippets", json({ html: "" }))).status, 400);
  assert.equal(
    (await app.request("/api/snippets", json({ html: "x".repeat(2 * 1024 * 1024 + 1) }))).status,
    413,
  );
});

test("ids are unguessable: 11 url-safe chars (~64 bits), not a 32-bit segment", async () => {
  const app = makeApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>hi</p>" }))).json()) as any;
  assert.match(s.id, /^[A-Za-z0-9_-]{11}$/);
  assert.match(s.sessionId, /^[A-Za-z0-9_-]{11}$/);
});

test("malformed base64 in an asset envelope is a 400, not a 500", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/assets",
    json({ data: "not valid base64!!!", contentType: "image/png" }),
  );
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error, /base64/);
});

test("comment text and titles are capped before they ride the feedback channel", async () => {
  const app = makeApp();
  const s = (await (
    await app.request("/api/snippets", json({ html: "<p>hi</p>", title: "T".repeat(1000) }))
  ).json()) as any;
  // title capped at the publish edge
  assert.equal(s.title.length, 500);

  await app.request(
    "/api/comments",
    json({ snippet: s.id, text: "x".repeat(20000), author: "user" }),
  );
  const all = (await (await app.request(`/api/comments?session=${s.sessionId}`)).json()) as any;
  assert.equal(all.comments[0].text.length, 8000);
  // the capped title is what gets snapshotted onto the comment (feedback view)
  assert.equal(all.comments[0].postTitle.length, 500);
});

// --- assets ---

const b64 = (bytes: number[]) => Buffer.from(new Uint8Array(bytes)).toString("base64");

test("uploads an asset via base64 JSON and serves the exact bytes", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/assets",
    json({ data: b64([137, 80, 78, 71, 0, 255]), contentType: "image/png", filename: "shot.png" }),
  );
  assert.equal(res.status, 201);
  const asset = (await res.json()) as any;
  assert.ok(asset.id);
  assert.ok(asset.sessionId); // auto-created a session
  assert.equal(asset.kind, "image"); // inferred from image/*
  assert.equal(asset.byteLength, 6);
  assert.ok(String(asset.url).endsWith(`/a/${asset.id}`));

  const served = await app.request(`/a/${asset.id}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("content-disposition"), "inline");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await served.arrayBuffer())], [137, 80, 78, 71, 0, 255]);
});

test("uploads raw bytes with metadata from the query string", async () => {
  const app = makeApp();
  const res = await app.request("/api/assets?filename=trace.json&kind=trace", {
    method: "POST",
    headers: { "content-type": "application/json-not" }, // non-json -> raw path
    body: new Uint8Array([123, 125]),
  });
  // content-type header here is the asset's own type, not the request envelope
  const raw = await app.request("/api/assets?kind=file", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array([1, 2, 3]),
  });
  assert.equal(raw.status, 201);
  const asset = (await raw.json()) as any;
  assert.equal(asset.kind, "file");
  assert.equal(asset.byteLength, 3);
  assert.ok(res.status === 201);
});

test("non-inline types are served as attachments and html is neutered", async () => {
  const app = makeApp();
  const svg = (await (
    await app.request("/api/assets", json({ data: b64([60, 115]), contentType: "image/svg+xml" }))
  ).json()) as any;
  const svgRes = await app.request(`/a/${svg.id}`);
  assert.equal(svgRes.headers.get("content-type"), "image/svg+xml");
  assert.match(svgRes.headers.get("content-disposition") ?? "", /^attachment/);

  const html = (await (
    await app.request("/api/assets", json({ data: b64([60, 104]), contentType: "text/html" }))
  ).json()) as any;
  const htmlRes = await app.request(`/a/${html.id}`);
  assert.equal(htmlRes.headers.get("content-type"), "application/octet-stream");
  assert.match(htmlRes.headers.get("content-disposition") ?? "", /^attachment/);
});

test("rejects empty and oversized uploads", async () => {
  const app = makeApp();
  assert.equal(
    (await app.request("/api/assets", json({ data: "", contentType: "x" }))).status,
    400,
  );
  const big = b64(Array(5 * 1024 * 1024 + 1).fill(0));
  assert.equal(
    (await app.request("/api/assets", json({ data: big, contentType: "image/png" }))).status,
    413,
  );
});

test("rejects an oversize Content-Length before buffering the body", async () => {
  const app = makeApp();
  // A raw-bytes POST whose declared Content-Length exceeds the cap must 413
  // without reading the body — the handler checks the header first.
  const res = await app.request("/api/assets?kind=file", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(5 * 1024 * 1024 + 1),
    },
    body: new Uint8Array(0), // no bytes actually sent — the check fires first
  });
  assert.equal(res.status, 413);
  assert.match(((await res.json()) as any).error, /exceeds/);
});

test("caps a chunked upload with no Content-Length instead of buffering it", async () => {
  const app = makeApp();
  // A streamed body sends no Content-Length, so the header early-out can't fire.
  // The handler must stop reading once the byte cap is exceeded rather than
  // buffering the whole stream (an unauthenticated OOM). Prove it stopped by
  // counting how many 1 MiB chunks the stream was actually asked for: if it read
  // everything it would pull all 40; capped at 5 MiB it should stop near 6.
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulled++;
      if (pulled > 40) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
  });
  const res = await app.request(
    new Request("http://localhost/api/assets?kind=file", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
  );
  assert.equal(res.status, 413);
  assert.match(((await res.json()) as any).error, /exceeds/);
  assert.ok(pulled < 16, `read too much before capping: ${pulled} chunks`);
});

test("assembles a valid multi-chunk streamed upload and stores it intact", async () => {
  const app = makeApp();
  // A streamed body under the cap must be accepted and its chunks reassembled
  // in order — every other upload test sends a single chunk, so this is the only
  // cover for a multi-chunk body surviving the bodyLimit re-wrap. We read the
  // asset back and compare bytes so a wrong offset/order would fail loudly.
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.enqueue(new Uint8Array([7, 8, 9]));
      controller.close();
    },
  });
  const res = await app.request(
    new Request("http://localhost/api/assets?kind=file", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
  );
  assert.equal(res.status, 201);
  const asset = (await res.json()) as any;
  assert.equal(asset.byteLength, 9);
  const served = await app.request(`/a/${asset.id}`);
  assert.deepEqual([...new Uint8Array(await served.arrayBuffer())], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("the global body cap rejects oversize JSON and MCP bodies", async () => {
  const app = makeApp();
  // Every write endpoint reads its body with an unbounded c.req.json(); the
  // global bodyLimit must refuse an oversize one with a 413 before it is read.
  // An over-cap Content-Length is the cheap path (no body buffered) — assert it
  // fires on a REST write endpoint and on /mcp, the two body-reading surfaces.
  const oversize = {
    "content-type": "application/json",
    "content-length": String(17 * 1024 * 1024),
  };
  const surfaces = await app.request("/api/surfaces", {
    method: "POST",
    headers: oversize,
    body: new Uint8Array(0), // no bytes sent — the Content-Length check fires first
  });
  assert.equal(surfaces.status, 413);
  const mcp = await app.request("/mcp", {
    method: "POST",
    headers: oversize,
    body: new Uint8Array(0),
  });
  assert.equal(mcp.status, 413);
});

test("uploading to an unknown session 404s; serving a missing asset 404s", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/assets",
    json({ data: b64([1]), contentType: "image/png", session: "nope" }),
  );
  assert.equal(res.status, 404);
  assert.equal((await app.request("/a/missing")).status, 404);
});

test("the surface CSP allows the server origin so assets embed by url", async () => {
  const app = makeApp();
  const snip = (await (
    await app.request("/api/snippets", json({ html: "<img src=/a/x>" }))
  ).json()) as any;
  const page = await (await app.request(`/s/${snip.id}?part=0`)).text();
  assert.match(page, /img-src https: data: blob: http:\/\/localhost/);
});

test("asset routes require auth when a token is set", async () => {
  const app = makeApp("secret");
  assert.equal(
    (await app.request("/api/assets", json({ data: b64([1]), contentType: "x" }))).status,
    401,
  );
  assert.equal((await app.request("/a/anything")).status, 401);
});

// --- URL routing: /session/:id and /session/:id/s/:surfaceId ---

test("/session/:id serves the viewer HTML", async () => {
  const app = makeApp();
  // create a session with a surface so the id is valid
  const s = (await (
    await app.request("/api/snippets", json({ html: "<p>x</p>", agent: "pi" }))
  ).json()) as any;
  const res = await app.request(`/session/${s.sessionId}`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));
  const body = await res.text();
  assert.ok(body.includes("viewer"), "should serve the viewer document");
});

test("/session/:id/s/:surfaceId serves the viewer HTML", async () => {
  const app = makeApp();
  const s = (await (
    await app.request("/api/snippets", json({ html: "<p>x</p>", agent: "pi" }))
  ).json()) as any;
  const res = await app.request(`/session/${s.sessionId}/s/${s.id}`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));
  const body = await res.text();
  assert.ok(body.includes("viewer"), "should serve the viewer document");
});

test("/session/:id serves viewer even for nonexistent session ids", async () => {
  const app = makeApp();
  // the SPA handles resolution; the server just serves the HTML
  const res = await app.request("/session/deadbeef");
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));
});

test("/session routes require auth when a token is set", async () => {
  const app = makeApp("secret");
  assert.equal((await app.request("/session/abc123")).status, 401);
  assert.equal((await app.request("/session/abc123/s/def456")).status, 401);
  // with auth they serve the viewer
  const authed = await app.request("/session/abc123", {
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(authed.status, 200);
  assert.ok((await authed.text()).includes("viewer"));
});

test("GET /api/comments?surface= filters to that surface, not the whole session", async () => {
  const app = makeApp();
  // Two surfaces in one session.
  const a = (await (
    await app.request("/api/snippets", json({ html: "<p>A</p>", sessionTitle: "S" }))
  ).json()) as any;
  const b = (await (
    await app.request("/api/snippets", json({ html: "<p>B</p>", session: a.sessionId }))
  ).json()) as any;

  // A comment on each surface.
  await app.request("/api/comments", json({ surface: a.id, text: "on A", author: "user" }));
  await app.request("/api/comments", json({ surface: b.id, text: "on B", author: "user" }));

  // Filtering by surface must return only that surface's comment. Regression
  // guard for the app→store query mapping (q.surfaceId → CommentQuery.postId):
  // a misnamed key silently drops the filter and returns the whole session.
  const onA = (await (
    await app.request(`/api/comments?session=${a.sessionId}&surface=${a.id}`)
  ).json()) as any;
  assert.equal(onA.comments.length, 1);
  assert.equal(onA.comments[0].postId, a.id);
  assert.equal(onA.comments[0].text, "on A");

  // Sanity: the session as a whole still has both comments.
  const allInSession = (await (
    await app.request(`/api/comments?session=${a.sessionId}`)
  ).json()) as any;
  assert.equal(allInSession.comments.length, 2);
});

// --- post/surface wire vocabulary (additive, backward-compatible) ---

test("POST /api/posts accepts a surfaces body and aliases /api/surfaces reads", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/posts",
    json({ title: "Via posts", surfaces: [{ kind: "html", html: "<p>post</p>" }] }),
  );
  assert.equal(res.status, 201);
  const created = (await res.json()) as any;
  assert.ok(created.id && created.sessionId);
  assert.deepEqual(created.kinds, ["html"]);

  // GET /api/posts/:id is identical to GET /api/surfaces/:id
  const viaPosts = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  const viaSurfaces = (await (await app.request(`/api/surfaces/${created.id}`)).json()) as any;
  assert.deepEqual(viaPosts, viaSurfaces);
  assert.equal(viaPosts.surfaces[0].html, "<p>post</p>");
});

test("POST /api/surfaces still accepts a legacy parts body", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/surfaces",
    json({ title: "Legacy", parts: [{ kind: "html", html: "<p>legacy</p>" }] }),
  );
  assert.equal(res.status, 201);
  const created = (await res.json()) as any;
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].html, "<p>legacy</p>");
});

test("POST /api/posts also accepts a legacy parts body (fallback)", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/posts",
    json({ title: "Fallback", parts: [{ kind: "html", html: "<p>fb</p>" }] }),
  );
  assert.equal(res.status, 201);
  const created = (await res.json()) as any;
  const full = (await (await app.request(`/api/surfaces/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].html, "<p>fb</p>");
});

test("missing blocks 400 mentions surfaces", async () => {
  const app = makeApp();
  const res = await app.request("/api/posts", json({ title: "Empty" }));
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.match(body.error, /surfaces/);
});

test("PUT /api/posts/:id revises with a surfaces body; DELETE /api/posts/:id removes", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Rev", surfaces: [{ kind: "html", html: "<p>v1</p>" }] }),
    )
  ).json()) as any;

  const put = await app.request(`/api/posts/${created.id}`, {
    ...json({ surfaces: [{ kind: "html", html: "<p>v2</p>" }] }),
    method: "PUT",
  });
  assert.equal(put.status, 200);
  const revised = (await put.json()) as any;
  assert.equal(revised.version, 2);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].html, "<p>v2</p>");

  const del = await app.request(`/api/posts/${created.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal((await app.request(`/api/posts/${created.id}`)).status, 404);
});

test("GET /p/:id and /p/:id?surface=N mirror /s/:id", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({
        title: "Pages",
        surfaces: [
          { kind: "html", html: "<p>first</p>" },
          { kind: "markdown", markdown: "## second" },
        ],
      }),
    )
  ).json()) as any;

  // shell page
  const shell = await app.request(`/p/${created.id}`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("content-type") ?? "", /text\/html/);

  // ?surface=N selects a block (sandboxed document), same as ?part=N
  const viaSurfaceQ = await app.request(`/p/${created.id}?surface=1`);
  assert.equal(viaSurfaceQ.status, 200);
  const bodyNew = await viaSurfaceQ.text();
  assert.ok(bodyNew.includes("second"));

  // legacy ?part still works on /s/:id
  const viaPartQ = await app.request(`/s/${created.id}?part=1`);
  assert.equal(viaPartQ.status, 200);
  assert.ok((await viaPartQ.text()).includes("second"));

  // cross matrix: new param on the old route, old param on the new route
  const oldRouteNewParam = await app.request(`/s/${created.id}?surface=1`);
  assert.equal(oldRouteNewParam.status, 200);
  assert.ok((await oldRouteNewParam.text()).includes("second"));
  const newRouteOldParam = await app.request(`/p/${created.id}?part=1`);
  assert.equal(newRouteOldParam.status, 200);
  assert.ok((await newRouteOldParam.text()).includes("second"));
});

test("PUT /api/posts/:id with surfaces:null is a 400, not a silent title-only update", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Orig", surfaces: [{ kind: "html", html: "<p>keep</p>" }] }),
    )
  ).json()) as any;

  // explicit null surfaces must be rejected (like POST), not ignored
  const bad = await app.request(`/api/posts/${created.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surfaces: null, title: "New" }),
  });
  assert.equal(bad.status, 400);
  // and the post is unchanged
  const after = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(after.title, "Orig");

  // a title-only update (no surfaces/parts field at all) still works
  const ok = await app.request(`/api/posts/${created.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Renamed" }),
  });
  assert.equal(ok.status, 200);
  assert.equal(
    ((await (await app.request(`/api/posts/${created.id}`)).json()) as any).title,
    "Renamed",
  );
});

test("GET /api/sessions/:id/posts mirrors /surfaces", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Listed", surfaces: [{ kind: "html", html: "<p>x</p>" }] }),
    )
  ).json()) as any;
  const viaPosts = (await (
    await app.request(`/api/sessions/${created.sessionId}/posts`)
  ).json()) as any;
  const viaSurfaces = (await (
    await app.request(`/api/sessions/${created.sessionId}/surfaces`)
  ).json()) as any;
  assert.deepEqual(viaPosts, viaSurfaces);
  assert.equal(viaPosts.length, 1);
});

test("GET /session/:id/p/:postId serves the viewer shell", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Nested", surfaces: [{ kind: "html", html: "<p>x</p>" }] }),
    )
  ).json()) as any;
  const page = await app.request(`/session/${created.sessionId}/p/${created.id}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
});

test("publish_post / update_post / list_posts MCP tools accept surfaces", async () => {
  const app = makeApp();
  const list = (await (await app.request("/mcp", mcpCall(1, "tools/list"))).json()) as any;
  const names = list.result.tools.map((t: any) => t.name);
  assert.ok(names.includes("publish_post"));
  assert.ok(names.includes("update_post"));
  assert.ok(names.includes("list_posts"));
  // old tools still advertised
  assert.ok(names.includes("publish_surface"));
  assert.ok(names.includes("list_surfaces"));

  const published = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "publish_post",
        arguments: {
          title: "Post",
          surfaces: [{ kind: "diff", patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+y" }],
        },
      }),
    )
  ).json()) as any;
  const payload = JSON.parse(published.result.content[0].text);
  assert.ok(payload.id && payload.sessionId);
  // new tools emit the canonical /p/ path
  assert.ok(payload.url.includes(`/p/${payload.id}`));
  const full = (await (await app.request(`/api/posts/${payload.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "diff");

  // update_post with surfaces
  const updated = (await (
    await app.request(
      "/mcp",
      mcpCall(3, "tools/call", {
        name: "update_post",
        arguments: { id: payload.id, surfaces: [{ kind: "html", html: "<p>updated</p>" }] },
      }),
    )
  ).json()) as any;
  const upPayload = JSON.parse(updated.result.content[0].text);
  assert.equal(upPayload.version, 2);
  assert.ok(upPayload.url.includes(`/p/${payload.id}`));

  // list_posts scoped to the session
  const listed = (await (
    await app.request(
      "/mcp",
      mcpCall(4, "tools/call", {
        name: "list_posts",
        arguments: { session: payload.sessionId },
      }),
    )
  ).json()) as any;
  const rows = JSON.parse(listed.result.content[0].text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, payload.id);
});

test("reply_to_user MCP tool accepts postId (and legacy surfaceId)", async () => {
  const app = makeApp();
  const published = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", {
        name: "publish_post",
        arguments: { title: "P", surfaces: [{ kind: "html", html: "<p>x</p>" }] },
      }),
    )
  ).json()) as any;
  const { id } = JSON.parse(published.result.content[0].text);

  // canonical postId arg
  const replied = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "reply_to_user",
        arguments: { postId: id, message: "ack", author: "test-agent" },
      }),
    )
  ).json()) as any;
  assert.ok(!replied.result.isError, replied.result.content?.[0]?.text);
  const comment = JSON.parse(replied.result.content[0].text);
  assert.equal(comment.text, "ack");
  assert.equal(comment.postId, id); // postId routed the reply to the right post's thread

  // legacy surfaceId arg still works
  const legacy = (await (
    await app.request(
      "/mcp",
      mcpCall(3, "tools/call", {
        name: "reply_to_user",
        arguments: { surfaceId: id, message: "ack2" },
      }),
    )
  ).json()) as any;
  assert.ok(!legacy.result.isError, legacy.result.content?.[0]?.text);
  assert.equal(JSON.parse(legacy.result.content[0].text).postId, id);

  // neither postId nor surfaceId → a clean error, not a crash
  const missing = (await (
    await app.request(
      "/mcp",
      mcpCall(4, "tools/call", {
        name: "reply_to_user",
        arguments: { message: "orphan" },
      }),
    )
  ).json()) as any;
  assert.ok(missing.result.isError);
});

test("publish_surface MCP tool still accepts legacy parts", async () => {
  const app = makeApp();
  const published = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "publish_surface",
        arguments: { title: "Legacy", parts: [{ kind: "html", html: "<p>old</p>" }] },
      }),
    )
  ).json()) as any;
  const payload = JSON.parse(published.result.content[0].text);
  assert.ok(payload.url.includes(`/s/${payload.id}`));
  const full = (await (await app.request(`/api/surfaces/${payload.id}`)).json()) as any;
  assert.equal(full.surfaces[0].html, "<p>old</p>");
});

// ---------------------------------------------------------------------------
// PATCH /api/posts/:id — content-only update (preserves surface kind)
// ---------------------------------------------------------------------------

const patch = (body: unknown) => ({
  method: "PATCH" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("PATCH /api/posts/:id updates markdown content preserving kind", async () => {
  const app = makeApp();
  // publish a markdown post
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "MD", surfaces: [{ kind: "markdown", markdown: "# v1" }] }),
    )
  ).json()) as any;

  // patch with new content
  const res = await app.request(`/api/posts/${created.id}`, patch({ content: "# v2" }));
  assert.equal(res.status, 200);
  const updated = (await res.json()) as any;
  assert.equal(updated.version, 2);

  // verify the surface kept its kind
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "markdown");
  assert.equal(full.surfaces[0].markdown, "# v2");
});

test("PATCH /api/posts/:id updates html content", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "HTML", surfaces: [{ kind: "html", html: "<p>v1</p>" }] }),
    )
  ).json()) as any;

  const res = await app.request(`/api/posts/${created.id}`, patch({ content: "<p>v2</p>" }));
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "html");
  assert.equal(full.surfaces[0].html, "<p>v2</p>");
});

test("PATCH /api/posts/:id updates code content preserving language", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({
        title: "Code",
        surfaces: [{ kind: "code", code: "const x = 1;", language: "typescript" }],
      }),
    )
  ).json()) as any;

  const res = await app.request(`/api/posts/${created.id}`, patch({ content: "const y = 2;" }));
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "code");
  assert.equal(full.surfaces[0].code, "const y = 2;");
  assert.equal(full.surfaces[0].language, "typescript");
});

test("PATCH /api/posts/:id updates diff content preserving layout", async () => {
  const app = makeApp();
  const diffPatch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new";
  const created = (await (
    await app.request(
      "/api/posts",
      json({
        title: "Diff",
        surfaces: [{ kind: "diff", patch: diffPatch, layout: "split" }],
      }),
    )
  ).json()) as any;

  const diffPatch2 = "--- a/y\n+++ b/y\n@@ -1 +1 @@\n-a\n+b";
  const res = await app.request(`/api/posts/${created.id}`, patch({ content: diffPatch2 }));
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "diff");
  assert.equal(full.surfaces[0].patch, diffPatch2);
  assert.equal(full.surfaces[0].layout, "split");
});

test("PATCH /api/posts/:id updates terminal content preserving cols", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({
        title: "Term",
        surfaces: [{ kind: "terminal", text: "$ ls\nfoo", cols: 80 }],
      }),
    )
  ).json()) as any;

  const res = await app.request(`/api/posts/${created.id}`, patch({ content: "$ ls\nbar" }));
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "terminal");
  assert.equal(full.surfaces[0].text, "$ ls\nbar");
  assert.equal(full.surfaces[0].cols, 80);
});

test("PATCH /api/posts/:id updates mermaid content", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Diagram", surfaces: [{ kind: "mermaid", mermaid: "graph LR; A-->B" }] }),
    )
  ).json()) as any;

  const res = await app.request(`/api/posts/${created.id}`, patch({ content: "graph TD; X-->Y" }));
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "mermaid");
  assert.equal(full.surfaces[0].mermaid, "graph TD; X-->Y");
});

test("PATCH /api/posts/:id updates json content (parses string)", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Data", surfaces: [{ kind: "json", data: { a: 1 } }] }),
    )
  ).json()) as any;

  const res = await app.request(`/api/posts/${created.id}`, patch({ content: '{"b":2}' }));
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "json");
  assert.deepEqual(full.surfaces[0].data, { b: 2 });
});

test("PATCH /api/posts/:id with invalid JSON content for json surface returns 400", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Data", surfaces: [{ kind: "json", data: { a: 1 } }] }),
    )
  ).json()) as any;

  const res = await app.request(`/api/posts/${created.id}`, patch({ content: "not valid json" }));
  assert.equal(res.status, 400);
});

test("PATCH /api/posts/:id updates title alongside content", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Old", surfaces: [{ kind: "markdown", markdown: "# old" }] }),
    )
  ).json()) as any;

  const res = await app.request(
    `/api/posts/${created.id}`,
    patch({ content: "# new", title: "New" }),
  );
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.title, "New");
  assert.equal(full.surfaces[0].markdown, "# new");
});

test("PATCH /api/posts/:id title-only update (no content)", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Old", surfaces: [{ kind: "markdown", markdown: "# keep" }] }),
    )
  ).json()) as any;

  const res = await app.request(`/api/posts/${created.id}`, patch({ title: "Renamed" }));
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.title, "Renamed");
  assert.equal(full.surfaces[0].markdown, "# keep");
});

test("PATCH /api/posts/:id rejects multi-surface posts", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({
        title: "Multi",
        surfaces: [
          { kind: "html", html: "<p>one</p>" },
          { kind: "markdown", markdown: "two" },
        ],
      }),
    )
  ).json()) as any;

  const res = await app.request(`/api/posts/${created.id}`, patch({ content: "new stuff" }));
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.ok(body.error);
});

test("PATCH /api/posts/:id rejects unsupported surface kinds (image, trace)", async () => {
  const app = makeApp();
  // image surfaces can't be content-updated (they reference an asset)
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Img", surfaces: [{ kind: "image", assetId: "abc123" }] }),
    )
  ).json()) as any;

  const res = await app.request(`/api/posts/${created.id}`, patch({ content: "nope" }));
  assert.equal(res.status, 400);
});

test("PATCH /api/posts/:id returns 404 for unknown id", async () => {
  const app = makeApp();
  const res = await app.request("/api/posts/nonexistent", patch({ content: "hi" }));
  assert.equal(res.status, 404);
});

test("PATCH /api/posts/:id with no content and no title returns 400", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "X", surfaces: [{ kind: "html", html: "<p>x</p>" }] }),
    )
  ).json()) as any;

  const res = await app.request(`/api/posts/${created.id}`, patch({}));
  assert.equal(res.status, 400);
});

test("PATCH /api/posts/:id updates kits on html surface", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Kit", surfaces: [{ kind: "html", html: "<p>x</p>", kits: ["issues"] }] }),
    )
  ).json()) as any;

  const res = await app.request(
    `/api/posts/${created.id}`,
    patch({ content: "<p>y</p>", kits: ["slides"] }),
  );
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].html, "<p>y</p>");
  assert.deepEqual(full.surfaces[0].kits, ["slides"]);
});

test("PATCH /api/posts/:id returns userFeedback like PUT does", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "FB", surfaces: [{ kind: "html", html: "<p>x</p>" }] }),
    )
  ).json()) as any;
  // leave a user comment so there's feedback to collect
  await app.request("/api/comments", json({ surface: created.id, text: "nice", author: "user" }));

  const res = await app.request(`/api/posts/${created.id}`, patch({ content: "<p>y</p>" }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.ok(Array.isArray(body.userFeedback));
});

test("PATCH /api/posts/:id bumps version and keeps history", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Hist", surfaces: [{ kind: "markdown", markdown: "# v1" }] }),
    )
  ).json()) as any;
  assert.equal(created.version, 1);

  await app.request(`/api/posts/${created.id}`, patch({ content: "# v2" }));

  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.version, 2);
  assert.equal(full.history.length, 1);
  assert.equal(full.history[0].surfaces[0].markdown, "# v1");
});

// ---------------------------------------------------------------------------
// Per-surface sub-resource routes (append / replace / remove / reorder)
// ---------------------------------------------------------------------------

test("POST /api/posts/:id/surfaces appends a surface", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Multi", surfaces: [{ kind: "html", html: "<p>first</p>" }] }),
    )
  ).json()) as any;

  const res = await app.request(
    `/api/posts/${created.id}/surfaces`,
    json({
      surface: { kind: "markdown", markdown: "# appended" },
    }),
  );
  assert.equal(res.status, 200);
  const updated = (await res.json()) as any;
  assert.deepEqual(updated.kinds, ["html", "markdown"]);

  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces.length, 2);
  assert.equal(full.surfaces[1].kind, "markdown");
  assert.equal(full.surfaces[1].markdown, "# appended");
  assert.ok(full.surfaces[1].id, "appended surface gets an id");
});

test("POST /api/posts/:id/surfaces inserts at a position via before/after", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({
        title: "Pos",
        surfaces: [
          { kind: "html", html: "<p>a</p>" },
          { kind: "html", html: "<p>b</p>" },
        ],
      }),
    )
  ).json()) as any;
  const full0 = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  const firstId = full0.surfaces[0].id;

  // Insert before the first surface (by id)
  await app.request(
    `/api/posts/${created.id}/surfaces`,
    json({
      surface: { kind: "markdown", markdown: "# inserted" },
      before: firstId,
    }),
  );
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.deepEqual(
    full.surfaces.map((s: any) => s.kind),
    ["markdown", "html", "html"],
  );
});

test("PATCH /api/posts/:id/surfaces/:target replaces a surface by id", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({
        title: "Rep",
        surfaces: [
          { kind: "html", html: "<p>orig</p>" },
          { kind: "markdown", markdown: "# keep" },
        ],
      }),
    )
  ).json()) as any;
  const full0 = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  const targetId = full0.surfaces[0].id;

  const res = await app.request(
    `/api/posts/${created.id}/surfaces/${targetId}`,
    patch({
      surface: { kind: "code", code: "console.log('new')" },
    }),
  );
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "code");
  assert.equal(full.surfaces[0].code, "console.log('new')");
  assert.equal(full.surfaces[0].id, targetId, "replaced surface keeps its id");
  assert.equal(full.surfaces[1].kind, "markdown", "other surface untouched");
});

test("PATCH /api/posts/:id/surfaces/:target full replacement applies kits to html surface", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({
        title: "Kits",
        surfaces: [
          { kind: "html", html: "<p>orig</p>" },
          { kind: "markdown", markdown: "# keep" },
        ],
      }),
    )
  ).json()) as any;
  const full0 = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  const targetId = full0.surfaces[0].id;

  const res = await app.request(
    `/api/posts/${created.id}/surfaces/${targetId}`,
    patch({
      surface: { kind: "html", html: "<p>new</p>" },
      kits: ["issues"],
    }),
  );
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[0].kind, "html");
  assert.equal(full.surfaces[0].html, "<p>new</p>");
  assert.deepEqual(full.surfaces[0].kits, ["issues"], "kits applied to full html replacement");
  assert.equal(full.surfaces[0].id, targetId, "replaced surface keeps its id");
});

test("PATCH /api/posts/:id/surfaces/:target content-only update by index", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({
        title: "CI",
        surfaces: [
          { kind: "html", html: "<p>a</p>" },
          { kind: "markdown", markdown: "# b" },
        ],
      }),
    )
  ).json()) as any;

  const res = await app.request(
    `/api/posts/${created.id}/surfaces/1`,
    patch({
      content: "# updated",
    }),
  );
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[1].kind, "markdown", "kind preserved");
  assert.equal(full.surfaces[1].markdown, "# updated");
  assert.equal(full.surfaces[0].html, "<p>a</p>", "other surface untouched");
});

test("DELETE /api/posts/:id/surfaces/:target removes a surface", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({
        title: "Del",
        surfaces: [
          { kind: "html", html: "<p>a</p>" },
          { kind: "markdown", markdown: "# b" },
        ],
      }),
    )
  ).json()) as any;

  const res = await app.request(`/api/posts/${created.id}/surfaces/1`, {
    method: "DELETE",
  });
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces.length, 1);
  assert.equal(full.surfaces[0].kind, "html");
});

test("DELETE /api/posts/:id/surfaces/:target rejects removing the last surface", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({ title: "Last", surfaces: [{ kind: "html", html: "<p>only</p>" }] }),
    )
  ).json()) as any;

  const res = await app.request(`/api/posts/${created.id}/surfaces/0`, {
    method: "DELETE",
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error, /at least one surface/);
});

test("PATCH /api/posts/:id/surfaces reorders surfaces by id", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({
        title: "Ord",
        surfaces: [
          { kind: "html", html: "<p>a</p>" },
          { kind: "markdown", markdown: "# b" },
          { kind: "code", code: "x" },
        ],
      }),
    )
  ).json()) as any;
  const full0 = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  const ids = full0.surfaces.map((s: any) => s.id);

  const res = await app.request(
    `/api/posts/${created.id}/surfaces`,
    patch({
      order: [ids[2], ids[0], ids[1]],
    }),
  );
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.deepEqual(
    full.surfaces.map((s: any) => s.kind),
    ["code", "html", "markdown"],
  );
  // ids are preserved on the surfaces
  assert.equal(full.surfaces[0].id, ids[2]);
  assert.equal(full.surfaces[1].id, ids[0]);
  assert.equal(full.surfaces[2].id, ids[1]);
});

test("PATCH /api/posts/:id with surface param targets multi-surface post", async () => {
  const app = makeApp();
  const created = (await (
    await app.request(
      "/api/posts",
      json({
        title: "T",
        surfaces: [
          { kind: "html", html: "<p>a</p>" },
          { kind: "markdown", markdown: "# b" },
        ],
      }),
    )
  ).json()) as any;
  const full0 = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  const targetId = full0.surfaces[1].id;

  // Content-only update targeting surface 1 by id
  const res = await app.request(
    `/api/posts/${created.id}`,
    patch({
      content: "# updated b",
      surface: targetId,
    }),
  );
  assert.equal(res.status, 200);
  const full = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(full.surfaces[1].markdown, "# updated b");
  assert.equal(full.surfaces[0].html, "<p>a</p>", "other surface untouched");
});

// ---------------------------------------------------------------------------
// MCP per-surface tools (add_surface / edit_surface / remove_surface / reorder_surfaces)
// ---------------------------------------------------------------------------

test("mcp add_surface appends a surface via HTTP MCP", async () => {
  const app = makeApp();
  const pub = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", {
        name: "publish_post",
        arguments: { title: "MCP", surfaces: [{ kind: "html", html: "<p>a</p>" }] },
      }),
    )
  ).json()) as any;
  const postId = JSON.parse(pub.result.content[0].text).id;

  const res = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "add_surface",
        arguments: { postId, surface: { kind: "markdown", markdown: "# appended" } },
      }),
    )
  ).json()) as any;
  assert.equal(res.result.isError, undefined);
  const out = JSON.parse(res.result.content[0].text);
  assert.equal(out.version, 2);
  assert.ok(out.url.includes(`/p/${postId}`));

  const full = (await (await app.request(`/api/posts/${postId}`)).json()) as any;
  assert.deepEqual(
    full.surfaces.map((s: any) => s.kind),
    ["html", "markdown"],
  );
});

test("mcp edit_surface content-only update via HTTP MCP", async () => {
  const app = makeApp();
  const pub = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", {
        name: "publish_post",
        arguments: {
          title: "MCP",
          surfaces: [
            { kind: "html", html: "<p>a</p>" },
            { kind: "markdown", markdown: "# b" },
          ],
        },
      }),
    )
  ).json()) as any;
  const postId = JSON.parse(pub.result.content[0].text).id;
  const full0 = (await (await app.request(`/api/posts/${postId}`)).json()) as any;
  const target = full0.surfaces[1].id;

  const res = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "edit_surface",
        arguments: { postId, target, content: "# updated via mcp" },
      }),
    )
  ).json()) as any;
  assert.equal(res.result.isError, undefined);

  const full = (await (await app.request(`/api/posts/${postId}`)).json()) as any;
  assert.equal(full.surfaces[1].markdown, "# updated via mcp");
  assert.equal(full.surfaces[1].id, target, "id preserved");
  assert.equal(full.surfaces[0].html, "<p>a</p>", "other surface untouched");
});

test("mcp remove_surface via HTTP MCP", async () => {
  const app = makeApp();
  const pub = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", {
        name: "publish_post",
        arguments: {
          title: "MCP",
          surfaces: [
            { kind: "html", html: "<p>keep</p>" },
            { kind: "markdown", markdown: "# remove me" },
          ],
        },
      }),
    )
  ).json()) as any;
  const postId = JSON.parse(pub.result.content[0].text).id;

  const res = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "remove_surface",
        arguments: { postId, target: "1" },
      }),
    )
  ).json()) as any;
  assert.equal(res.result.isError, undefined);

  const full = (await (await app.request(`/api/posts/${postId}`)).json()) as any;
  assert.equal(full.surfaces.length, 1);
  assert.equal(full.surfaces[0].kind, "html");
});

test("mcp reorder_surfaces via HTTP MCP", async () => {
  const app = makeApp();
  const pub = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", {
        name: "publish_post",
        arguments: {
          title: "MCP",
          surfaces: [
            { kind: "html", html: "<p>a</p>" },
            { kind: "markdown", markdown: "# b" },
            { kind: "code", code: "x" },
          ],
        },
      }),
    )
  ).json()) as any;
  const postId = JSON.parse(pub.result.content[0].text).id;
  const full0 = (await (await app.request(`/api/posts/${postId}`)).json()) as any;
  const ids = full0.surfaces.map((s: any) => s.id);

  const res = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "reorder_surfaces",
        arguments: { postId, order: [ids[2], ids[0], ids[1]] },
      }),
    )
  ).json()) as any;
  assert.equal(res.result.isError, undefined);

  const full = (await (await app.request(`/api/posts/${postId}`)).json()) as any;
  assert.deepEqual(
    full.surfaces.map((s: any) => s.kind),
    ["code", "html", "markdown"],
  );
});

test("mcp tools/list includes the new per-surface tools", async () => {
  const app = makeApp();
  const list = (await (await app.request("/mcp", mcpCall(1, "tools/list"))).json()) as any;
  const names = list.result.tools.map((t: any) => t.name);
  assert.ok(names.includes("add_surface"));
  assert.ok(names.includes("edit_surface"));
  assert.ok(names.includes("remove_surface"));
  assert.ok(names.includes("reorder_surfaces"));
});

test("mcp get_post fetches a single post with surface ids via HTTP MCP", async () => {
  const app = makeApp();
  const pub = (await (
    await app.request(
      "/mcp",
      mcpCall(1, "tools/call", {
        name: "publish_post",
        arguments: {
          title: "GetPost",
          surfaces: [
            { kind: "html", html: "<p>a</p>" },
            { kind: "markdown", markdown: "# b" },
          ],
        },
      }),
    )
  ).json()) as any;
  const postId = JSON.parse(pub.result.content[0].text).id;

  const res = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", {
        name: "get_post",
        arguments: { id: postId },
      }),
    )
  ).json()) as any;
  assert.equal(res.result.isError, undefined);
  const post = JSON.parse(res.result.content[0].text);
  assert.equal(post.id, postId);
  assert.equal(post.title, "GetPost");
  assert.equal(post.surfaces.length, 2);
  assert.equal(post.surfaces[0].kind, "html");
  assert.equal(post.surfaces[1].kind, "markdown");
  assert.ok(post.surfaces[0].id, "surface ids are present");
  assert.ok(post.surfaces[1].id);
});

test("mcp tools/list includes get_post", async () => {
  const app = makeApp();
  const list = (await (await app.request("/mcp", mcpCall(1, "tools/list"))).json()) as any;
  const names = list.result.tools.map((t: any) => t.name);
  assert.ok(names.includes("get_post"));
});

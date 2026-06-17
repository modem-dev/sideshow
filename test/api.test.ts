import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { JsonFileStore } from "../server/storage.ts";

function makeApp(authToken?: string) {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-test-"));
  const store = new JsonFileStore(join(dir, "data.json"));
  return createApp({
    store,
    viewerHtml: "<html>viewer</html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    authToken,
  });
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
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

test("publishes a combined html+diff surface; /s renders the html part only", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/surfaces",
    json({
      title: "Review",
      parts: [
        { kind: "html", html: "<p>diagram</p>" },
        { kind: "diff", patch: "@@ -1 +1 @@\n-a\n+b", layout: "split" },
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
  assert.equal(full.parts.length, 2);
  assert.equal(full.parts[0].html, "<p>diagram</p>");
  assert.equal(full.parts[1].patch, "@@ -1 +1 @@\n-a\n+b");

  // /s renders the requested html part; a diff part has no html doc
  const part0 = await app.request(`/s/${surface.id}?part=0`);
  assert.ok((await part0.text()).includes("<p>diagram</p>"));
  assert.equal((await app.request(`/s/${surface.id}?part=1`)).status, 404);
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
  assert.deepEqual(unchanged.parts, [{ kind: "html", html: "<p>x</p>" }]);
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
        arguments: { title: "Diff", parts: [{ kind: "diff", patch: "@@ -1 +1 @@\n-x\n+y" }] },
      }),
    )
  ).json()) as any;
  const payload = JSON.parse(published.result.content[0].text);
  assert.ok(payload.id && payload.sessionId);
  const full = (await (await app.request(`/api/surfaces/${payload.id}`)).json()) as any;
  assert.equal(full.parts[0].kind, "diff");
  assert.equal(full.parts[0].patch, "@@ -1 +1 @@\n-x\n+y");
});

test("publishes a markdown part; /s has no html doc for it", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/surfaces",
    json({ title: "Plan", parts: [{ kind: "markdown", markdown: "## Plan\n\n- step one" }] }),
  );
  assert.equal(res.status, 201);
  const surface = (await res.json()) as any;
  assert.deepEqual(surface.kinds, ["markdown"]);

  const full = (await (await app.request(`/api/surfaces/${surface.id}`)).json()) as any;
  assert.equal(full.parts[0].kind, "markdown");
  assert.equal(full.parts[0].markdown, "## Plan\n\n- step one");
  // markdown is viewer-rendered data, not a sandboxed html doc
  assert.equal((await app.request(`/s/${surface.id}?part=0`)).status, 404);
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
  assert.equal(full.parts.length, 1);
  assert.equal(full.parts[0].kind, "markdown");
  assert.equal(full.parts[0].markdown, "real prose");
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
  assert.equal(full.parts[0].kind, "terminal");
  assert.equal(full.parts[0].text, "$ echo hi\n\x1b[32mhi\x1b[0m");
  assert.equal(full.parts[0].cols, 80);
  assert.equal(full.parts[0].title, "sh");
  // a terminal part has no html doc, so /s 404s like diff/image/trace
  assert.equal((await app.request(`/s/${payload.id}?part=0`)).status, 404);
});

test("publishes a mermaid part; /s has no html doc for it", async () => {
  const app = makeApp();
  const res = await app.request(
    "/api/surfaces",
    json({ title: "Flow", parts: [{ kind: "mermaid", mermaid: "graph TD; A-->B" }] }),
  );
  assert.equal(res.status, 201);
  const surface = (await res.json()) as any;
  assert.deepEqual(surface.kinds, ["mermaid"]);

  const full = (await (await app.request(`/api/surfaces/${surface.id}`)).json()) as any;
  assert.equal(full.parts[0].kind, "mermaid");
  assert.equal(full.parts[0].mermaid, "graph TD; A-->B");
  // mermaid is viewer-rendered data, not a sandboxed html doc
  assert.equal((await app.request(`/s/${surface.id}?part=0`)).status, 404);
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
  assert.equal(full.parts.length, 1);
  assert.equal(full.parts[0].kind, "mermaid");
  assert.equal(full.parts[0].mermaid, "graph TD; A-->B");
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
  assert.equal(full.history[0].parts[0].html, "<p>v1</p>");

  const current = await (await app.request(`/s/${s.id}`)).text();
  assert.ok(current.includes("<p>v2</p>"));
  const old = await (await app.request(`/s/${s.id}?ver=1`)).text();
  assert.ok(old.includes("<p>v1</p>"));
});

test("snippet page is wrapped with CSP, bridge, and kit", async () => {
  const app = makeApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  const page = await (await app.request(`/s/${s.id}`)).text();
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
  assert.equal(all.comments[0].surfaceTitle, "Sketch");

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

function makeVersionApp(version?: string, latest?: { version: string; notes?: string } | Error) {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-test-"));
  return createApp({
    store: new JsonFileStore(join(dir, "data.json")),
    viewerHtml: "<html>viewer</html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
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

test("auth token guards mutating routes when configured", async () => {
  const app = makeApp("secret");
  const denied = await app.request("/api/snippets", json({ html: "<p>x</p>" }));
  assert.equal(denied.status, 401);
  const allowed = await app.request("/api/snippets", {
    ...json({ html: "<p>x</p>" }),
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
  });
  assert.equal(allowed.status, 201);
  // full surface is guarded, including reads and the viewer
  assert.equal((await app.request("/api/sessions")).status, 401);
  assert.equal((await app.request("/")).status, 401);
  // docs stay open
  assert.equal((await app.request("/guide")).status, 200);
  assert.equal((await app.request("/setup")).status, 200);
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

test("agent writes piggyback unseen user comments, delivered once", async () => {
  const app = makeApp();
  const s = (await (
    await app.request("/api/snippets", json({ html: "<p>v1</p>", title: "Doc" }))
  ).json()) as any;
  assert.equal(s.userFeedback, undefined);

  // the user comments while the agent works on something else
  await app.request("/api/comments", json({ snippet: s.id, text: "wrong color", author: "user" }));
  await app.request("/api/comments", json({ session: s.sessionId, text: "also add a key" }));

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
  const page = await (await app.request(`/s/${snip.id}`)).text();
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

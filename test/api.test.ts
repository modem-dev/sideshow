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
  assert.equal(sessions[0].snippetCount, 1);
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
  assert.equal(full.history[0].html, "<p>v1</p>");

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
  assert.equal(all.comments[0].snippetTitle, "Sketch");

  const users = (await (
    await app.request(`/api/comments?session=${s.sessionId}&author=user`)
  ).json()) as any;
  assert.equal(users.comments.length, 1);
  assert.equal(users.comments[0].text, "love it");

  const later = (await (
    await app.request(`/api/comments?session=${s.sessionId}&after=${all.lastSeq}`)
  ).json()) as any;
  assert.equal(later.comments.length, 0);
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
  assert.equal(updated.userFeedback[0].snippetTitle, "Doc");

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

// The built-in welcome/test post (server/welcomePost.ts): the fixed card
// send_test_post (MCP) / POST /api/test-post (REST, which the CLI and the
// stdio MCP server call) publishes. Pins the tier parity, the fixed
// title/session, and — hardest to see from the outside — the idempotency
// guard: a board only ever accumulates ONE welcome card no matter how many
// times an eager agent calls the tool.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { HTTP_MCP_TOOLS, MCP_INSTRUCTIONS } from "../server/mcpSpec.ts";
import { JsonFileStore } from "../server/storage.ts";
import { WELCOME_POST_TITLE, WELCOME_SESSION_TITLE } from "../server/welcomePost.ts";

function makeApp(authToken?: string) {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-test-"));
  const store = new JsonFileStore(join(dir, "data.json"));
  return createApp({
    store,
    viewerHtml: "<html><head></head><body>viewer</body></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    agentHowtoText: "# agent how-to",
    authToken,
  });
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const mcpCall = (id: number, method: string, params?: unknown) =>
  json({ jsonrpc: "2.0", id, method, params });

test("POST /api/test-post publishes the welcome card once, then returns it (idempotent)", async () => {
  const app = makeApp();

  const first = await app.request("/api/test-post", json({ agent: "test-agent" }));
  assert.equal(first.status, 201);
  const created = (await first.json()) as any;
  assert.ok(created.id);
  assert.equal(created.alreadySent, undefined);

  // The card carries the fixed title and lands in its own "Getting started"
  // session (not any task session).
  const post = (await (await app.request(`/api/posts/${created.id}`)).json()) as any;
  assert.equal(post.title, WELCOME_POST_TITLE);
  assert.equal(post.surfaces.length, 1);
  assert.equal(post.surfaces[0].kind, "html");
  const sessions = (await (await app.request("/api/sessions")).json()) as any[];
  const welcomeSession = sessions.find((s) => s.id === created.sessionId);
  assert.equal(welcomeSession?.title, WELCOME_SESSION_TITLE);

  // Second call: the existing card comes back — same id, flagged, NOT a dupe.
  const second = await app.request("/api/test-post", json({}));
  assert.equal(second.status, 200);
  const again = (await second.json()) as any;
  assert.equal(again.id, created.id);
  assert.equal(again.alreadySent, true);

  // A body-less curl works too (the body is optional on this route).
  const bare = await app.request("/api/test-post", { method: "POST" });
  assert.equal(bare.status, 200);
  assert.equal(((await bare.json()) as any).id, created.id);

  const posts = (await (
    await app.request(`/api/sessions/${created.sessionId}/posts`)
  ).json()) as any[];
  assert.equal(posts.length, 1);
});

test("the send_test_post MCP tool is advertised and publishes the same card", async () => {
  const app = makeApp();

  // Advertised on tools/list, and nudged in the initialize instructions.
  const list = (await (await app.request("/mcp", mcpCall(1, "tools/list"))).json()) as any;
  assert.ok(list.result.tools.some((t: any) => t.name === "send_test_post"));
  assert.match(MCP_INSTRUCTIONS, /send_test_post/);
  assert.ok(HTTP_MCP_TOOLS.some((t) => t.name === "send_test_post"));

  const call = (await (
    await app.request(
      "/mcp",
      mcpCall(2, "tools/call", { name: "send_test_post", arguments: { agent: "claude-code" } }),
    )
  ).json()) as any;
  assert.equal(call.result.isError, undefined);
  const created = JSON.parse(call.result.content[0].text);
  assert.ok(created.id);
  assert.match(created.url, /\/p\//);

  // Idempotent through the MCP tier too: the same post, flagged alreadySent.
  const repeat = (await (
    await app.request("/mcp", mcpCall(3, "tools/call", { name: "send_test_post", arguments: {} }))
  ).json()) as any;
  const again = JSON.parse(repeat.result.content[0].text);
  assert.equal(again.id, created.id);
  assert.equal(again.alreadySent, true);

  // And the REST tier sees the MCP-published card (one shared implementation).
  const rest = await app.request("/api/test-post", { method: "POST" });
  assert.equal(rest.status, 200);
  assert.equal(((await rest.json()) as any).id, created.id);
});

test("the test-post route is a write: token-gated like any publish", async () => {
  const app = makeApp("secret");
  const denied = await app.request("/api/test-post", { method: "POST" });
  assert.equal(denied.status, 401);
  const allowed = await app.request("/api/test-post", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(allowed.status, 201);
});

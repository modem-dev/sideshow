import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { createSqliteStorage } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { JsonFileStore } from "../server/storage.ts";

function makeApp(authToken?: string, opts?: { publicRead?: "session" | "full" }) {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-recent-test-"));
  const store = new JsonFileStore(join(dir, "data.json"));
  return createApp({
    store,
    viewerHtml: "<html><head></head><body>viewer</body></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    agentHowtoText: "# agent how-to",
    authToken,
    ...opts,
  });
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Publish a surface; returns the lean write response ({ id, sessionId, ... }).
async function publish(app: ReturnType<typeof makeApp>, body: unknown) {
  const res = await app.request("/api/surfaces", json(body));
  if (res.status !== 201) assert.fail(`publish failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as any;
}

// Create a session up front so we can publish into it with a known agent/title.
async function createSession(app: ReturnType<typeof makeApp>, agent: string, title?: string) {
  const res = await app.request("/api/sessions", json({ agent, title }));
  assert.equal(res.status, 201);
  return (await res.json()) as any;
}

test("GET /api/surfaces/recent returns posts newest-first across sessions", async () => {
  const app = makeApp();
  const a = await createSession(app, "amp", "Session A");
  const b = await createSession(app, "pi", "Session B");

  // Publish in an interleaved order; updatedAt (touched on create) drives recency.
  const p1 = await publish(app, {
    session: a.id,
    title: "first",
    parts: [{ kind: "html", html: "<p>1</p>" }],
  });
  await new Promise((r) => setTimeout(r, 5));
  const p2 = await publish(app, {
    session: b.id,
    title: "second",
    parts: [{ kind: "html", html: "<p>2</p>" }],
  });
  await new Promise((r) => setTimeout(r, 5));
  const p3 = await publish(app, {
    session: a.id,
    title: "third",
    parts: [{ kind: "html", html: "<p>3</p>" }],
  });

  const feed = (await (await app.request("/api/surfaces/recent")).json()) as any[];
  assert.equal(feed.length, 3);
  assert.deepEqual(
    feed.map((x) => x.id),
    [p3.id, p2.id, p1.id],
  );

  // Each item carries session context for the feed card.
  const top = feed[0];
  assert.equal(top.sessionId, a.id);
  assert.equal(top.sessionTitle, "Session A");
  assert.equal(top.agent, "amp");
  assert.equal(top.title, "third");
  assert.deepEqual(top.partKinds, ["html"]);
  assert.ok(Array.isArray(top.parts));

  const middle = feed[1];
  assert.equal(middle.sessionId, b.id);
  assert.equal(middle.agent, "pi");
});

test("GET /api/surfaces/recent respects and clamps limit", async () => {
  const app = makeApp();
  const s = await createSession(app, "amp");
  for (let i = 0; i < 5; i++) {
    await publish(app, { session: s.id, parts: [{ kind: "html", html: `<p>${i}</p>` }] });
  }

  const two = (await (await app.request("/api/surfaces/recent?limit=2")).json()) as any[];
  assert.equal(two.length, 2);

  // a fractional limit truncates to an integer before it reaches SQLite LIMIT.
  const fractional = (await (await app.request("/api/surfaces/recent?limit=1.5")).json()) as any[];
  assert.equal(fractional.length, 1);

  // a negative limit clamps up to 1.
  const clampedLow = (await (await app.request("/api/surfaces/recent?limit=-5")).json()) as any[];
  assert.equal(clampedLow.length, 1);

  // garbage / 0 falls back to default (20) → all 5 returned.
  const fallback = (await (await app.request("/api/surfaces/recent?limit=abc")).json()) as any[];
  assert.equal(fallback.length, 5);
  const zero = (await (await app.request("/api/surfaces/recent?limit=0")).json()) as any[];
  assert.equal(zero.length, 5);

  // limit above 100 clamps to 100 (we only have 5, so this just confirms no error).
  const high = (await (await app.request("/api/surfaces/recent?limit=9999")).json()) as any[];
  assert.equal(high.length, 5);
});

// SqlStore used to pass fractional values directly to SQLite LIMIT, which errors.
// Keep an endpoint-level regression test so parsing stays store-safe.
test("GET /api/surfaces/recent truncates fractional limits before querying SqlStore", async () => {
  const store = new SqlStore(createSqliteStorage(":memory:"));
  const app = createApp({
    store,
    viewerHtml: "<html><head></head><body>viewer</body></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    agentHowtoText: "# agent how-to",
  });
  const s = await createSession(app, "amp");
  await publish(app, { session: s.id, parts: [{ kind: "html", html: "<p>x</p>" }] });

  const res = await app.request("/api/surfaces/recent?limit=1.5");
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any[]).length, 1);
});

test("GET /api/surfaces/recent caps oversized text parts and flags truncation", async () => {
  const app = makeApp();
  const s = await createSession(app, "amp");
  const bigHtml = "x".repeat(20_000);
  const bigMarkdown = "# ".repeat(10_000); // 20k chars
  const bigDiffSide = "-".repeat(20_000);
  const bigJsonString = "j".repeat(20_000);
  const smallCode = "const a = 1;";
  await publish(app, {
    session: s.id,
    parts: [
      { kind: "html", html: bigHtml },
      { kind: "markdown", markdown: bigMarkdown },
      { kind: "diff", files: [{ filename: "big.txt", before: bigDiffSide, after: "small" }] },
      { kind: "json", data: bigJsonString },
      { kind: "code", code: smallCode, language: "ts" },
    ],
  });

  const feed = (await (await app.request("/api/surfaces/recent")).json()) as any[];
  const parts = feed[0].parts;

  const html = parts.find((p: any) => p.kind === "html");
  assert.equal(html.html.length, 8_000); // PART_TEXT_CAP
  assert.equal(html.truncated, true);

  const md = parts.find((p: any) => p.kind === "markdown");
  assert.equal(md.markdown.length, 8_000);
  assert.equal(md.truncated, true);

  const diff = parts.find((p: any) => p.kind === "diff");
  assert.equal(diff.files[0].before.length, 8_000);
  assert.equal(diff.truncated, true);

  const jsonPart = parts.find((p: any) => p.kind === "json");
  assert.equal(jsonPart.data.length, 8_000);
  assert.equal(jsonPart.truncated, true);

  // a small part is left whole, with no truncated flag.
  const code = parts.find((p: any) => p.kind === "code");
  assert.equal(code.code, smallCode);
  assert.equal(code.truncated, undefined);
});

test("GET /api/surfaces/recent leaves image parts as plain assetId refs", async () => {
  const app = makeApp();
  const s = await createSession(app, "amp");

  // Upload an asset via the JSON envelope to get a real assetId.
  const upload = (await (
    await app.request("/api/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: Buffer.from("\x89PNG\r\n\x1a\n px").toString("base64"),
        contentType: "image/png",
        filename: "shot.png",
        kind: "image",
        session: s.id,
      }),
    })
  ).json()) as any;
  assert.ok(upload.id);

  await publish(app, {
    session: s.id,
    parts: [{ kind: "image", assetId: upload.id, alt: "a shot" }],
  });

  const feed = (await (await app.request("/api/surfaces/recent")).json()) as any[];
  const img = feed[0].parts.find((p: any) => p.kind === "image");
  assert.equal(img.assetId, upload.id);
  assert.equal(img.alt, "a shot");
  assert.equal(img.truncated, undefined);
});

test("GET /api/surfaces/recent is auth-gated exactly like /api/sessions", async () => {
  // With an auth token configured, both routes require it.
  const guarded = makeApp("secret");
  await guarded.request("/api/surfaces", {
    ...json({ parts: [{ kind: "html", html: "<p>x</p>" }] }),
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
  });
  assert.equal((await guarded.request("/api/sessions")).status, 401);
  assert.equal((await guarded.request("/api/surfaces/recent")).status, 401);
  const ok = await guarded.request("/api/surfaces/recent", {
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(ok.status, 200);

  // On a session-scoped publicRead board, /api/sessions is NOT public — and
  // neither is /api/surfaces/recent (it must not broaden access).
  const board = makeApp("secret", { publicRead: "session" });
  assert.equal((await board.request("/api/sessions")).status, 401);
  assert.equal((await board.request("/api/surfaces/recent")).status, 401);
  // the per-surface read IS public on a session board — recent must NOT be.
  const made = (await (
    await board.request("/api/surfaces", {
      ...json({ parts: [{ kind: "html", html: "<p>x</p>" }] }),
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
    })
  ).json()) as any;
  assert.equal((await board.request(`/api/surfaces/${made.id}`)).status, 200);
  assert.equal((await board.request("/api/surfaces/recent")).status, 401);
});

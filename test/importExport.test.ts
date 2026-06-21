import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { JsonFileStore } from "../server/storage.ts";

function makeApp(authToken?: string) {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-import-export-test-"));
  const store = new JsonFileStore(join(dir, "data.json"));
  const app = createApp({
    store,
    viewerHtml: "<html>viewer</html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    agentHowtoText: "# agent how-to",
    authToken,
  });
  return { app, store };
}

const b64 = (bytes: number[]) => Buffer.from(new Uint8Array(bytes)).toString("base64");

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const authedJson = (body: unknown, token = "secret") => ({
  ...json(body),
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
});

function normalizeExport(data: any) {
  return {
    sessions: [...data.sessions].sort((a, b) => a.id.localeCompare(b.id)),
    surfaces: [...data.surfaces].sort((a, b) => a.id.localeCompare(b.id)),
    comments: [...data.comments].sort((a, b) => a.seq - b.seq),
    assets: [...data.assets].sort((a, b) => a.id.localeCompare(b.id)),
    trace: data.trace,
    settings: data.settings,
    commentSeq: data.commentSeq,
  };
}

test("import/export endpoints require auth when configured", async () => {
  const { app } = makeApp("secret");

  assert.equal((await app.request("/api/export")).status, 401);
  assert.equal((await app.request("/api/import", json({ sessions: [] }))).status, 401);

  assert.equal(
    (await app.request("/api/export", { headers: { authorization: "Bearer secret" } })).status,
    200,
  );
  assert.equal((await app.request("/api/import", authedJson({ sessions: [] }))).status, 200);
});

test("POST /api/import rejects invalid JSON", async () => {
  const { app } = makeApp();
  const res = await app.request("/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("GET /api/export returns sessions, surfaces, comments, assets, and all settings", async () => {
  const { app, store } = makeApp();
  const created = (await (
    await app.request("/api/snippets", json({ html: "<p>x</p>", title: "Sketch", agent: "pi" }))
  ).json()) as any;
  await app.request(
    "/api/comments",
    json({ snippet: created.id, text: "ship it", author: "user" }),
  );
  const asset = (await (
    await app.request(
      "/api/assets",
      json({
        session: created.sessionId,
        data: b64([1, 2, 3]),
        contentType: "image/png",
        filename: "shot.png",
      }),
    )
  ).json()) as any;
  await app.request(
    `/api/sessions/${created.sessionId}/trace`,
    json({ steps: [{ kind: "tool", label: "npm test", detail: "passed" }] }),
  );
  await store.setSetting("theme", "gruvbox");
  await store.setSetting("sidebar", "collapsed");

  const exported = (await (await app.request("/api/export")).json()) as any;

  assert.equal(exported.sessions.length, 1);
  assert.equal(exported.sessions[0].id, created.sessionId);
  assert.equal(exported.surfaces.length, 1);
  assert.equal(exported.surfaces[0].id, created.id);
  assert.equal(exported.comments.length, 1);
  assert.equal(exported.comments[0].text, "ship it");
  assert.equal(exported.commentSeq, exported.comments[0].seq);
  assert.deepEqual(exported.settings, { theme: "gruvbox", sidebar: "collapsed" });
  assert.deepEqual(exported.trace, {
    [created.sessionId]: [{ kind: "tool", label: "npm test", detail: "passed" }],
  });
  assert.equal(exported.assets.length, 1);
  assert.deepEqual(exported.assets[0], {
    id: asset.id,
    sessionId: created.sessionId,
    kind: "image",
    contentType: "image/png",
    byteLength: 3,
    filename: "shot.png",
    data: b64([1, 2, 3]),
    createdAt: exported.assets[0].createdAt,
    lastAccessedAt: exported.assets[0].lastAccessedAt,
  });
});

test("POST /api/import preserves IDs and imported assets are served", async () => {
  const { app } = makeApp();
  const imported = {
    sessions: [
      {
        id: "known-session",
        agent: "pi",
        title: "Imported session",
        cwd: "/repo",
        createdAt: "2026-06-21T00:00:00.000Z",
        lastActiveAt: "2026-06-21T00:00:01.000Z",
        agentSeq: 0,
      },
    ],
    surfaces: [
      {
        id: "known-surface",
        sessionId: "known-session",
        title: "Imported surface",
        parts: [{ kind: "image", assetId: "known-asset", alt: "blob" }],
        createdAt: "2026-06-21T00:00:02.000Z",
        updatedAt: "2026-06-21T00:00:02.000Z",
        version: 1,
        history: [],
      },
    ],
    comments: [
      {
        id: "known-comment",
        seq: 99,
        sessionId: "known-session",
        surfaceId: "known-surface",
        surfaceTitle: "Imported surface",
        author: "user",
        text: "hello import",
        createdAt: "2026-06-21T00:00:03.000Z",
      },
    ],
    assets: [
      {
        id: "known-asset",
        sessionId: "known-session",
        kind: "file",
        contentType: "application/octet-stream",
        byteLength: 4,
        filename: "blob.bin",
        data: b64([5, 6, 7, 8]),
        createdAt: "2026-06-21T00:00:04.000Z",
        lastAccessedAt: "2026-06-21T00:00:05.000Z",
      },
    ],
    trace: {
      "known-session": [
        { kind: "prompt", label: "read prompt", ts: "2026-06-21T00:00:06.000Z" },
        { kind: "tool", label: "write code", detail: "done" },
      ],
    },
    settings: { theme: "gruvbox" },
  };

  const res = await app.request("/api/import", json(imported));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    sessions: 1,
    surfaces: 1,
    comments: 1,
    assets: 1,
  });

  const sessions = (await (await app.request("/api/sessions")).json()) as any[];
  assert.equal(sessions[0].id, "known-session");
  const surface = (await (await app.request("/api/surfaces/known-surface")).json()) as any;
  assert.equal(surface.id, "known-surface");
  assert.equal(surface.parts[0].assetId, "known-asset");
  const comments = (await (await app.request("/api/comments?session=known-session")).json()) as any;
  assert.equal(comments.comments[0].id, "known-comment");
  assert.equal(comments.comments[0].seq, 99);
  assert.deepEqual(
    ((await (await app.request("/api/sessions/known-session/trace")).json()) as any).steps,
    imported.trace["known-session"],
  );
  assert.equal(((await (await app.request("/api/theme")).json()) as any).id, "gruvbox");
  const asset = await app.request("/a/known-asset");
  assert.equal(asset.status, 200);
  assert.deepEqual([...new Uint8Array(await asset.arrayBuffer())], [5, 6, 7, 8]);
});

test("GET /api/export includes referenced assets whose owning session was deleted", async () => {
  const { app, store } = makeApp();
  const owner = await store.createSession({ agent: "pi", title: "asset owner" });
  const asset = await store.putAsset({
    sessionId: owner.id,
    kind: "image",
    contentType: "image/png",
    filename: "orphaned-owner.png",
    data: new Uint8Array([10, 20, 30]),
  });
  assert.ok(asset);
  const survivor = await store.createSession({ agent: "pi", title: "survivor" });
  const surface = await store.createSurface({
    sessionId: survivor.id,
    title: "References old asset",
    parts: [{ kind: "image", assetId: asset.id, alt: "still live" }],
  });
  assert.ok(surface);

  assert.equal(await store.removeSession(owner.id), true);
  assert.ok(await store.getAsset(asset.id), "referenced asset should survive owner deletion");

  const exported = (await (await app.request("/api/export")).json()) as any;

  assert.equal(
    exported.sessions.some((s: any) => s.id === owner.id),
    false,
  );
  assert.equal(
    exported.surfaces.some((s: any) => s.id === surface.id),
    true,
  );
  assert.equal(
    exported.assets.some((a: any) => a.id === asset.id && a.data === b64([10, 20, 30])),
    true,
  );

  const target = makeApp();
  assert.equal((await target.app.request("/api/import", json(exported))).status, 200);
  const served = await target.app.request(`/a/${asset.id}`);
  assert.equal(served.status, 200);
  assert.deepEqual([...new Uint8Array(await served.arrayBuffer())], [10, 20, 30]);
});

test("import preserves comment sequence high-water mark after deleted delivered feedback", async () => {
  const source = makeApp();
  const session = await source.store.createSession({ agent: "pi", title: "feedback cursor" });
  const surface = await source.store.createSurface({
    sessionId: session.id,
    title: "Temporary",
    parts: [{ kind: "html", html: "<p>old</p>" }],
  });
  assert.ok(surface);
  const delivered = await source.store.createComment({
    sessionId: session.id,
    surfaceId: surface.id,
    author: "user",
    text: "already seen",
  });
  assert.ok(delivered);
  await source.store.markAgentSeen(session.id, delivered.seq);
  assert.equal(await source.store.removeSurface(surface.id), true);

  const exported = (await (await source.app.request("/api/export")).json()) as any;
  assert.equal(exported.comments.length, 0);
  assert.equal(exported.sessions[0].agentSeq, delivered.seq);
  assert.ok(exported.commentSeq >= delivered.seq);

  const target = makeApp();
  assert.equal((await target.app.request("/api/import", json(exported))).status, 200);
  const importedSession = await target.store.getSession(session.id);
  assert.ok(importedSession);
  const newSurface = await target.store.createSurface({
    sessionId: session.id,
    title: "New",
    parts: [{ kind: "html", html: "<p>new</p>" }],
  });
  assert.ok(newSurface);
  const fresh = await target.store.createComment({
    sessionId: session.id,
    surfaceId: newSurface.id,
    author: "user",
    text: "must be delivered",
  });
  assert.ok(fresh);

  assert.ok(fresh.seq > importedSession.agentSeq);
  assert.deepEqual(
    await target.store.listComments({ sessionId: session.id, afterSeq: importedSession.agentSeq }),
    [fresh],
  );
});

test("exported data can be imported into another server without changing shape", async () => {
  const source = makeApp();
  const created = (await (
    await source.app.request(
      "/api/snippets",
      json({ html: "<p>round trip</p>", title: "Round trip", agent: "pi" }),
    )
  ).json()) as any;
  await source.app.request(
    "/api/assets",
    json({ session: created.sessionId, data: b64([9, 8, 7]), contentType: "text/plain" }),
  );
  await source.app.request(
    "/api/comments",
    json({ snippet: created.id, text: "round-trip comment", author: "user" }),
  );
  await source.app.request(
    `/api/sessions/${created.sessionId}/trace`,
    json({ steps: [{ kind: "prompt", label: "trace survives export" }] }),
  );
  await source.store.setSetting("theme", "one");
  await source.store.setSetting("sidebar", "expanded");

  const exported = (await (await source.app.request("/api/export")).json()) as any;
  const target = makeApp();
  assert.equal((await target.app.request("/api/import", json(exported))).status, 200);
  const reexported = (await (await target.app.request("/api/export")).json()) as any;

  assert.deepEqual(normalizeExport(reexported), normalizeExport(exported));
});

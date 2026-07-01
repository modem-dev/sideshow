import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSqliteStorage, migrateJsonToSqlite } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { JsonFileStore } from "../server/storage.ts";
import type { WorkspaceSnapshot } from "../server/types.ts";

const tmpJson = () => join(mkdtempSync(join(tmpdir(), "sideshow-mig-")), "data.json");

test("migrates a JSON workspace into SQLite preserving identity, history, and seq", async () => {
  const jsonPath = tmpJson();
  const json = new JsonFileStore(jsonPath);
  const session = await json.createSession({ agent: "pi", title: "Sess" });
  // a surface that gets updated, so it carries a version bump + one history entry
  const surface = (await json.createPost({
    sessionId: session.id,
    title: "S",
    surfaces: [{ kind: "html", html: "<p>v1</p>" }],
  }))!;
  await json.updatePost(surface.id, { surfaces: [{ kind: "html", html: "<p>v2</p>" }] });
  // comments — seq + ordering drive the feedback cursor
  const c1 = (await json.createComment({
    sessionId: session.id,
    postId: surface.id,
    author: "user",
    text: "first",
  }))!;
  const c2 = (await json.createComment({
    sessionId: session.id,
    author: "agent",
    text: "second",
  }))!;
  await json.markAgentSeen(session.id, c1.seq);
  await json.setTrace(session.id, [{ label: "step one", kind: "run" }]);
  await json.setSetting("theme", "gruvbox");
  const asset = (await json.putAsset({
    sessionId: session.id,
    kind: "image",
    contentType: "image/png",
    data: new Uint8Array([1, 2, 3, 4]),
  }))!;

  const sqlite = new SqlStore(createSqliteStorage());
  await migrateJsonToSqlite(sqlite, jsonPath);

  // session identity + the agentSeq cursor
  const sessions = await sqlite.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, session.id);
  assert.equal(sessions[0].agentSeq, c1.seq);

  // surface version + history survive
  const s = (await sqlite.getPost(surface.id))!;
  assert.equal(s.version, 2);
  assert.equal(s.history.length, 1);
  assert.equal((s.surfaces[0] as { html: string }).html, "<p>v2</p>");
  assert.equal((s.history[0].surfaces[0] as { html: string }).html, "<p>v1</p>");

  // comments keep their seq + order, and a new comment continues past them
  const comments = await sqlite.listComments({ sessionId: session.id });
  assert.deepEqual(
    comments.map((c) => c.seq),
    [c1.seq, c2.seq],
  );
  assert.equal(comments[0].id, c1.id);
  assert.equal(comments[0].postId, surface.id);
  const c3 = (await sqlite.createComment({
    sessionId: session.id,
    author: "user",
    text: "third",
  }))!;
  assert.ok(c3.seq > c2.seq, "new seq must not collide with imported ones");

  // trace, setting, and asset bytes
  assert.deepEqual(
    (await sqlite.listTrace(session.id)).map((t) => t.label),
    ["step one"],
  );
  assert.equal(await sqlite.getSetting("theme"), "gruvbox");
  assert.deepEqual([...(await sqlite.getAsset(asset.id))!.data], [1, 2, 3, 4]);
});

test("migration is idempotent — a second run is a no-op", async () => {
  const jsonPath = tmpJson();
  const json = new JsonFileStore(jsonPath);
  const session = await json.createSession({ agent: "pi" });
  await json.createPost({
    sessionId: session.id,
    title: "S",
    surfaces: [{ kind: "html", html: "<p>x</p>" }],
  });

  const sqlite = new SqlStore(createSqliteStorage());
  await migrateJsonToSqlite(sqlite, jsonPath);
  await migrateJsonToSqlite(sqlite, jsonPath);
  assert.equal((await sqlite.listPosts()).length, 1);
  assert.ok((await sqlite.getSetting("importedFrom"))?.length);
});

test("migration never imports into a SQLite db that already has data", async () => {
  const jsonPath = tmpJson();
  const json = new JsonFileStore(jsonPath);
  const js = await json.createSession({ agent: "pi" });
  await json.createPost({
    sessionId: js.id,
    title: "JSON",
    surfaces: [{ kind: "html", html: "<p>json</p>" }],
  });

  const sqlite = new SqlStore(createSqliteStorage());
  const native = await sqlite.createSession({ agent: "amp" });
  await sqlite.createPost({
    sessionId: native.id,
    title: "NATIVE",
    surfaces: [{ kind: "html", html: "<p>native</p>" }],
  });

  await migrateJsonToSqlite(sqlite, jsonPath);
  assert.deepEqual(
    (await sqlite.listPosts()).map((x) => x.title),
    ["NATIVE"],
  );
});

test("importBoard (legacy snapshot API) rolls back fully if an insert fails partway through", async () => {
  const sqlite = new SqlStore(createSqliteStorage());
  const now = "2026-01-01T00:00:00Z";
  const session = {
    id: "dup",
    agent: "pi",
    title: null,
    cwd: null,
    createdAt: now,
    lastActiveAt: now,
    agentSeq: 0,
  };
  // Two sessions share a primary key: the first INSERT succeeds, the second
  // throws — so the transaction must roll the first one back too.
  const bad: WorkspaceSnapshot = {
    sessions: [session, session],
    posts: [],
    comments: [],
    traces: [],
    assets: [],
    settings: [{ key: "theme", value: "one" }],
  };
  assert.throws(() => sqlite.importBoard(bad));
  // nothing partially imported — not the first session, not the settings
  assert.equal((await sqlite.listSessions()).length, 0);
  assert.equal(await sqlite.getSetting("theme"), null);
});

test("migration survives a corrupt JSON file — warns, skips, leaves the db empty", async () => {
  const jsonPath = tmpJson();
  writeFileSync(jsonPath, "{ this is not valid json");
  const sqlite = new SqlStore(createSqliteStorage());
  // must NOT throw (a truncated/corrupt file can't be allowed to crash boot)
  await migrateJsonToSqlite(sqlite, jsonPath);
  assert.equal((await sqlite.listSessions()).length, 0);
  // sentinel left unset so a later fixed file still migrates
  assert.equal(await sqlite.getSetting("importedFrom"), null);
});

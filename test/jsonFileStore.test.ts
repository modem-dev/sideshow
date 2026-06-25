import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonFileStore } from "../server/storage.ts";
import { htmlSurface } from "../server/types.ts";
import { runStoreContract } from "./storeContract.ts";

const freshPath = () => join(mkdtempSync(join(tmpdir(), "sideshow-store-")), "data.json");

runStoreContract("JsonFileStore", () => new JsonFileStore(freshPath()));

test("JsonFileStore: concurrent first calls share one disk load", async () => {
  const path = freshPath();
  const seed = new JsonFileStore(path);
  const persisted = await seed.createSession({ agent: "old", title: "Persisted" });

  const cold = new JsonFileStore(path);
  const [, created] = await Promise.all([
    cold.listSessions(),
    cold.createSession({ agent: "new", title: "Concurrent" }),
  ]);

  const reloaded = new JsonFileStore(path);
  const sessions = await reloaded.listSessions();
  assert.deepEqual(new Set(sessions.map((s) => s.id)), new Set([persisted.id, created.id]));
});

test("JsonFileStore: data survives a reload from disk", async () => {
  const path = freshPath();
  const store = new JsonFileStore(path);
  const session = await store.createSession({ agent: "pi", title: "Persisted" });
  const surface = await store.createPost({
    sessionId: session.id,
    surfaces: [htmlSurface("<p>x</p>")],
  });
  await store.updatePost(surface?.id ?? "", { surfaces: [htmlSurface("<p>v2</p>")] });
  await store.createComment({
    sessionId: session.id,
    postId: surface?.id,
    author: "user",
    text: "hi",
  });

  await store.markAgentSeen(session.id, 1);

  const reloaded = new JsonFileStore(path);
  assert.equal((await reloaded.getSession(session.id))?.title, "Persisted");
  assert.equal((await reloaded.getSession(session.id))?.agentSeq, 1);
  const got = await reloaded.getPost(surface?.id ?? "");
  assert.equal(got?.version, 2);
  assert.equal(got?.history.length, 1);
  const comments = await reloaded.listComments({});
  assert.equal(comments.length, 1);
  // lastSeq is restored too: the next comment continues the sequence
  const next = await reloaded.createComment({ sessionId: session.id, author: "user", text: "2" });
  assert.ok(next && next.seq > comments[0].seq);
});

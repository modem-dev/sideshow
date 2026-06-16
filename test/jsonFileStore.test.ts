import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonFileStore } from "../server/storage.ts";
import { htmlPart } from "../server/types.ts";
import { runStoreContract } from "./storeContract.ts";

const freshPath = () => join(mkdtempSync(join(tmpdir(), "sideshow-store-")), "data.json");

runStoreContract("JsonFileStore", () => new JsonFileStore(freshPath()));

test("JsonFileStore: data survives a reload from disk", async () => {
  const path = freshPath();
  const store = new JsonFileStore(path);
  const session = await store.createSession({ agent: "pi", title: "Persisted" });
  const surface = await store.createSurface({
    sessionId: session.id,
    parts: [htmlPart("<p>x</p>")],
  });
  await store.updateSurface(surface?.id ?? "", { parts: [htmlPart("<p>v2</p>")] });
  await store.createComment({
    sessionId: session.id,
    surfaceId: surface?.id,
    author: "user",
    text: "hi",
  });

  await store.markAgentSeen(session.id, 1);

  const reloaded = new JsonFileStore(path);
  assert.equal((await reloaded.getSession(session.id))?.title, "Persisted");
  assert.equal((await reloaded.getSession(session.id))?.agentSeq, 1);
  const got = await reloaded.getSurface(surface?.id ?? "");
  assert.equal(got?.version, 2);
  assert.equal(got?.history.length, 1);
  const comments = await reloaded.listComments({});
  assert.equal(comments.length, 1);
  // lastSeq is restored too: the next comment continues the sequence
  const next = await reloaded.createComment({ sessionId: session.id, author: "user", text: "2" });
  assert.ok(next && next.seq > comments[0].seq);
});

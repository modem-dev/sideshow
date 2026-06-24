import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import { createSqliteStorage } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";

// The comment→agent feedback cursor (agentSeq, exactly-once delivery,
// author=user filtering, piggyback) is the product's crown jewel and is covered
// extensively against JsonFileStore in api.test.ts. SqlStore is now the default
// local store, so re-run the core of that flow against it to prove the cursor
// behaves identically on the SQLite path (markAgentSeen + the createComment
// touch() interaction, in particular).
function makeSqlApp() {
  const store = new SqlStore(createSqliteStorage());
  return createApp({
    store,
    viewerHtml: "<html>v</html>",
    guideMarkdown: "#",
    setupText: "#",
    agentHowtoText: "#",
  });
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("SqlStore: author=user feedback delivers exactly once; the viewer read is unaffected", async () => {
  const app = makeSqlApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  await app.request("/api/comments", json({ snippet: s.id, text: "first", author: "user" }));

  // cursor-less read delivers it once...
  const first = (await (
    await app.request(`/api/comments?session=${s.sessionId}&author=user`)
  ).json()) as any;
  assert.equal(first.comments.length, 1);
  assert.equal(first.comments[0].text, "first");

  // ...and the advanced cursor means a second cursor-less read gets nothing
  const again = (await (
    await app.request(`/api/comments?session=${s.sessionId}&author=user`)
  ).json()) as any;
  assert.equal(again.comments.length, 0);

  // the viewer's unfiltered read never consumes the cursor
  const viewer = (await (await app.request(`/api/comments?session=${s.sessionId}`)).json()) as any;
  assert.equal(viewer.comments.length, 1);
});

test("SqlStore: piggybacked feedback on a write advances the cursor; only author=user is delivered", async () => {
  const app = makeSqlApp();
  const s = (await (await app.request("/api/snippets", json({ html: "<p>x</p>" }))).json()) as any;
  await app.request("/api/comments", json({ snippet: s.id, text: "tweak it", author: "user" }));

  // the agent's write piggybacks the pending feedback...
  const updated = (await (
    await app.request(`/api/snippets/${s.id}`, { ...json({ html: "<p>v2</p>" }), method: "PUT" })
  ).json()) as any;
  assert.equal(updated.userFeedback.length, 1);
  assert.equal(updated.userFeedback[0].text, "tweak it");

  // ...so a cursor-less wait on another channel must not re-deliver it
  const wait = (await (
    await app.request(`/api/comments?session=${s.sessionId}&author=user`)
  ).json()) as any;
  assert.equal(wait.comments.length, 0);

  // a surface-authored comment is never delivered as user feedback
  await app.request(
    "/api/comments",
    json({ session: s.sessionId, text: "auto", author: "surface" }),
  );
  const afterSurface = (await (
    await app.request(`/api/comments?session=${s.sessionId}&author=user`)
  ).json()) as any;
  assert.equal(afterSurface.comments.length, 0);
});

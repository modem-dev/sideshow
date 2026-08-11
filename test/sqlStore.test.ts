import assert from "node:assert/strict";
import { test } from "node:test";
import { createSqliteStorage } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { htmlSurface, type SqlStorage } from "../server/types.ts";
import { runStoreContract } from "./storeContract.ts";

// Runs the shared store contract against SqlStore on node:sqlite (:memory:) —
// the same adapter the local server uses on disk, so the contract exercises the
// real Node SQLite path rather than a bespoke shim.
runStoreContract("SqlStore", () => new SqlStore(createSqliteStorage()));

const hotPathIndexes = {
  sideshow_assets_session_idx: ["sessionId"],
  sideshow_comments_id_idx: ["id"],
  sideshow_comments_post_seq_idx: ["postId", "seq"],
  sideshow_comments_session_seq_idx: ["sessionId", "seq"],
  sideshow_posts_session_created_at_idx: ["sessionId", "createdAt"],
  sideshow_posts_updated_at_idx: ["updatedAt"],
} as const;

test("SqlStore adds hot-path indexes to existing workspaces idempotently", () => {
  const storage = createSqliteStorage();
  new SqlStore(storage);

  // Model a database created by an older release, before these indexes existed.
  for (const name of Object.keys(hotPathIndexes)) storage.exec(`DROP INDEX ${name}`);

  new SqlStore(storage);
  new SqlStore(storage);

  const indexes = storage
    .exec(
      "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'sideshow_%' ORDER BY name",
    )
    .toArray();
  assert.deepEqual(
    indexes.map((row) => row.name),
    Object.keys(hotPathIndexes),
  );
  for (const [name, columns] of Object.entries(hotPathIndexes)) {
    const actual = storage
      .exec(`SELECT name FROM pragma_index_info('${name}') ORDER BY seqno`)
      .toArray()
      .map((row) => row.name);
    assert.deepEqual(actual, columns, `${name} column order`);
  }
});

test("SqlStore hot queries use their covering or ordering indexes", () => {
  const storage = createSqliteStorage();
  new SqlStore(storage);

  const assertUsesIndex = (query: string, index: string, ...bindings: (string | number)[]) => {
    const plan = storage
      .exec(`EXPLAIN QUERY PLAN ${query}`, ...bindings)
      .toArray()
      .map((row) => row.detail)
      .join("\n");
    assert.match(plan, new RegExp(`\\b${index}\\b`), `${query}\n${plan}`);
  };

  assertUsesIndex(
    "SELECT * FROM posts WHERE sessionId = ? ORDER BY createdAt ASC",
    "sideshow_posts_session_created_at_idx",
    "session",
  );
  assertUsesIndex(
    "SELECT sessionId, COUNT(*) AS count FROM posts GROUP BY sessionId",
    "sideshow_posts_session_created_at_idx",
  );
  assertUsesIndex(
    "SELECT * FROM posts ORDER BY updatedAt DESC LIMIT ?",
    "sideshow_posts_updated_at_idx",
    20,
  );
  assertUsesIndex(
    "SELECT * FROM comments WHERE sessionId = ? AND seq > ? ORDER BY seq ASC",
    "sideshow_comments_session_seq_idx",
    "session",
    10,
  );
  assertUsesIndex(
    "SELECT * FROM comments WHERE postId = ? AND seq > ? ORDER BY seq ASC",
    "sideshow_comments_post_seq_idx",
    "post",
    10,
  );
  assertUsesIndex("SELECT * FROM comments WHERE id = ?", "sideshow_comments_id_idx", "comment");
  assertUsesIndex(
    "SELECT * FROM assets WHERE sessionId = ?",
    "sideshow_assets_session_idx",
    "session",
  );
});

test("SqlStore counts posts with one aggregate query and never selects body columns", async () => {
  const storage = createSqliteStorage();
  const queries: string[] = [];
  const tracked: SqlStorage = {
    exec(query, ...bindings) {
      queries.push(query.replace(/\s+/g, " ").trim());
      return storage.exec(query, ...bindings);
    },
  };
  const store = new SqlStore(tracked);
  const session = await store.createSession({ agent: "pi" });
  await store.createPost({ sessionId: session.id, surfaces: [htmlSurface("<p>large</p>")] });

  queries.length = 0;
  const counts = await store.countPostsBySession();

  assert.equal(counts.get(session.id), 1);
  assert.deepEqual(queries, ["SELECT sessionId, COUNT(*) AS count FROM posts GROUP BY sessionId"]);
});

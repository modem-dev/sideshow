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

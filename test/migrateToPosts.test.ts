import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSqliteStorage } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { JsonFileStore } from "../server/storage.ts";
import type { SqlStorage } from "../server/types.ts";

// Build a raw 0.5.x-shaped database: a `surfaces` table whose blocks live in a
// `parts` column, plus a `comments` table keyed by `surfaceId`/`surfaceTitle`.
// Constructing a SqlStore over this storage runs migrateToPosts() in the
// constructor, which must lift everything into the posts model in place.
function seedLegacyBoard(storage: SqlStorage): void {
  storage.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, title TEXT, cwd TEXT,
      createdAt TEXT NOT NULL, lastActiveAt TEXT NOT NULL,
      agentSeq INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE surfaces (
      id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, title TEXT NOT NULL,
      parts TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      version INTEGER NOT NULL, history TEXT NOT NULL
    );
    CREATE TABLE comments (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
      sessionId TEXT NOT NULL, surfaceId TEXT, surfaceTitle TEXT,
      author TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL
    );
  `);
  const now = "2026-01-01T00:00:00Z";
  storage.exec(
    "INSERT INTO sessions (id, agent, title, cwd, createdAt, lastActiveAt, agentSeq) VALUES (?, ?, ?, ?, ?, ?, ?)",
    "sess1",
    "pi",
    "Sess",
    null,
    now,
    now,
    0,
  );
  const blocks = JSON.stringify([{ kind: "html", html: "<p>v2</p>" }]);
  // Legacy history stored each version's blocks under `parts` (not `surfaces`).
  const history = JSON.stringify([
    { version: 1, title: "Old", parts: [{ kind: "html", html: "<p>v1</p>" }], at: now },
  ]);
  storage.exec(
    "INSERT INTO surfaces (id, sessionId, title, parts, createdAt, updatedAt, version, history) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "post1",
    "sess1",
    "Card",
    blocks,
    now,
    now,
    2,
    history,
  );
  storage.exec(
    "INSERT INTO comments (id, sessionId, surfaceId, surfaceTitle, author, text, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    "c1",
    "sess1",
    "post1",
    "Card",
    "user",
    "nice",
    now,
  );
}

test("migrateToPosts lifts a legacy surfaces table into the posts model", async () => {
  const storage = createSqliteStorage();
  seedLegacyBoard(storage);

  // Constructing the store runs the migration in its constructor.
  const store = new SqlStore(storage);

  // The post is readable via getPost/listPosts, with its blocks under
  // `surfaces` (lifted from the legacy `parts` column) and history intact.
  const post = (await store.getPost("post1"))!;
  assert.ok(post, "post lifted from legacy surfaces table");
  assert.equal(post.title, "Card");
  assert.equal(post.version, 2);
  assert.equal((post.surfaces[0] as { html: string }).html, "<p>v2</p>");
  // History is re-keyed too: each version's legacy `parts` becomes `surfaces`,
  // matching the JSON backend (storage.ts liftPost). A verbatim copy would leave
  // inner `parts` keys that readers (older-version views, asset GC) see as
  // undefined.
  assert.equal(post.history.length, 1);
  assert.equal(post.history[0].version, 1);
  assert.equal((post.history[0].surfaces[0] as { html: string }).html, "<p>v1</p>");

  const all = await store.listPosts();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "post1");

  // The comment keeps its post linkage (surfaceId/surfaceTitle → postId/postTitle).
  const comments = await store.listComments({ sessionId: "sess1" });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].postId, "post1");
  assert.equal(comments[0].postTitle, "Card");

  // Filtering comments by postId uses the renamed column.
  const byPost = await store.listComments({ postId: "post1" });
  assert.equal(byPost.length, 1);
  assert.equal(byPost[0].id, "c1");

  // The legacy `surfaces` table is gone after the lift.
  const tables = storage
    .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
    .toArray()
    .map((t) => t.name as string);
  assert.ok(!tables.includes("surfaces"), "legacy surfaces table dropped");
  assert.ok(tables.includes("posts"), "posts table present");
});

test("migrateToPosts is idempotent — constructing twice over one db is a no-op", async () => {
  const storage = createSqliteStorage();
  seedLegacyBoard(storage);

  // First construction migrates; a second over the same storage must neither
  // throw (no `surfaces` table, columns already renamed) nor duplicate rows.
  const first = new SqlStore(storage);
  assert.equal((await first.listPosts()).length, 1);

  const second = new SqlStore(storage);
  assert.equal((await second.listPosts()).length, 1, "no duplicate posts on re-run");
  const comments = await second.listComments({ sessionId: "sess1" });
  assert.equal(comments.length, 1, "no duplicate comments on re-run");
  assert.equal(comments[0].postId, "post1");
});

// The other legacy shape: pre-0.5.0 JSON workspaces stored a `snippets` array,
// each a single `html` string with its own version history — no surfaces at all.
// JsonFileStore lifts those on load (liftSnippet), which is the JSON-side
// counterpart of migrateToPosts above, and the same invariant: a workspace
// written by an old release must open with its content and history intact.
test("JsonFileStore lifts pre-0.5.0 snippets into posts with html surfaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-legacy-json-"));
  const file = join(dir, "data.json");
  const now = "2026-01-01T00:00:00Z";
  writeFileSync(
    file,
    JSON.stringify({
      sessions: [
        { id: "sess1", agent: "pi", title: "Sess", createdAt: now, lastActiveAt: now, agentSeq: 0 },
      ],
      snippets: [
        {
          id: "snip1",
          sessionId: "sess1",
          title: "Legacy card",
          html: "<p>current</p>",
          createdAt: now,
          updatedAt: now,
          version: 2,
          history: [{ version: 1, title: "Legacy card", html: "<p>first</p>", at: now }],
        },
      ],
      comments: [],
    }),
  );

  const store = new JsonFileStore(file);
  const posts = await store.listPosts("sess1");
  assert.equal(posts.length, 1);
  const [post] = posts;
  assert.equal(post.id, "snip1");
  assert.equal(post.title, "Legacy card");
  assert.equal(post.version, 2);
  // The bare `html` string becomes a one-surface post — the modern shape. The
  // lift mints a surface id, so compare the content fields, not the whole object.
  assert.equal(post.surfaces.length, 1);
  assert.equal(post.surfaces[0].kind, "html");
  assert.equal((post.surfaces[0] as { html: string }).html, "<p>current</p>");
  // History is lifted the same way, so older versions stay viewable.
  assert.equal(post.history.length, 1);
  assert.equal(post.history[0].version, 1);
  assert.equal(post.history[0].surfaces.length, 1);
  assert.equal((post.history[0].surfaces[0] as { html: string }).html, "<p>first</p>");
});

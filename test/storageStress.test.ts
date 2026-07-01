import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSqliteStorage, migrateJsonToSqlite } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { JsonFileStore } from "../server/storage.ts";
import type { Store } from "../server/types.ts";

// ---- deterministic PRNG so a failing seed reproduces exactly ----
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, n: number) => Math.floor(r() * n);
const pick = <T>(r: () => number, a: T[]): T => a[int(r, a.length)];
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const NUL = String.fromCharCode(0);

// A pool of nasty strings, including an embedded NUL — both stores strip NUL,
// so the fuzzer's byte-faithful check also exercises NUL-in-text parity.
const NASTY = [
  "hello",
  "café ☕",
  "日本語テキスト",
  "emoji 🎉👍🏽👨‍👩‍👧",
  "rtl العربية mixed",
  `quote " apos ' semi ; dashes -- comment`,
  "<script>alert(1)</script>",
  "tab\tand\nnewline",
  "</surface></script>",
  "'); DROP TABLE comments;--",
  "",
  "🧵".repeat(40),
  `embedded${NUL}nul`,
];
const text = (r: () => number) => (r() < 0.8 ? pick(r, NASTY) : `rand-${int(r, 1e9)}`);
const maybe = <T>(r: () => number, fn: () => T): T | undefined => (r() < 0.5 ? fn() : undefined);

function randomParts(r: () => number): unknown[] {
  return range(1 + int(r, 3)).map(() => {
    switch (int(r, 5)) {
      case 0:
        return { kind: "html", html: `<p>${text(r)}</p>` };
      case 1:
        return { kind: "markdown", markdown: `# ${text(r)}` };
      case 2:
        return { kind: "code", code: text(r), language: pick(r, ["ts", "py", "text"]) };
      case 3:
        return { kind: "json", json: { v: int(r, 1000), s: text(r) } };
      default:
        return { kind: "terminal", terminal: text(r) };
    }
  });
}

async function buildRandomBoard(store: Store, r: () => number) {
  const sessionIds: string[] = [];
  const surfaces: { id: string; sessionId: string }[] = [];
  for (let i = 0; i < 1 + int(r, 5); i++) {
    const sess = await store.createSession({
      agent: pick(r, ["pi", "amp", "claude", "  spaced  "]),
      title: maybe(r, () => text(r)),
      cwd: maybe(r, () => `/work/${int(r, 9999)}`),
    });
    sessionIds.push(sess.id);
    for (let j = 0; j < int(r, 4); j++) {
      const surf = await store.createPost({
        sessionId: sess.id,
        title: text(r),
        surfaces: randomParts(r) as never,
      });
      if (!surf) continue;
      surfaces.push({ id: surf.id, sessionId: sess.id });
      // sometimes more than HISTORY_LIMIT (20) updates → exercises history capping
      for (let k = 0; k < int(r, 25); k++) {
        await store.updatePost(surf.id, {
          title: maybe(r, () => text(r)),
          surfaces: maybe(r, () => randomParts(r) as never),
        });
      }
    }
    if (r() < 0.5) {
      await store.setTrace(
        sess.id,
        range(int(r, 6)).map(() => ({
          label: text(r),
          kind: maybe(r, () => "run"),
          detail: maybe(r, () => text(r)),
        })),
      );
    }
  }
  for (let i = 0; i < int(r, 30); i++) {
    const useSurface = surfaces.length > 0 && r() < 0.7;
    const target = useSurface
      ? pick(r, surfaces)
      : { id: undefined, sessionId: pick(r, sessionIds) };
    await store.createComment({
      sessionId: target.sessionId,
      postId: useSurface ? target.id : undefined,
      author: pick(r, ["user", "agent", "surface", "claude"]),
      text: text(r),
    });
  }
  for (let i = 0; i < int(r, 5); i++) {
    await store.putAsset({
      sessionId: pick(r, sessionIds),
      kind: pick(r, ["image", "file", "trace"]),
      contentType: pick(r, ["image/png", "application/octet-stream", "text/plain"]),
      data: new Uint8Array(range(1 + int(r, 64)).map(() => int(r, 256))),
      filename: maybe(r, () => `f-${int(r, 999)}.bin`),
    });
  }
  // vary agentSeq (the feedback cursor) so migration must carry it
  for (const sid of sessionIds) if (r() < 0.5) await store.markAgentSeen(sid, int(r, 10));
  for (const k of ["theme", "layout", "custom"]) if (r() < 0.6) await store.setSetting(k, text(r));
}

// Full readable snapshot of a store's data. Migration preserves ids/timestamps/
// seq verbatim, so json-source and migrated-sqlite snapshots must be deep-equal.
// Sorted by stable keys so we compare DATA, not millisecond-tie list ordering.
async function snapshot(store: Store) {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sessions = (await store.listSessions()).slice().sort(byId);
  const surfaces = (await store.listPosts()).slice().sort(byId);
  const comments = (await store.listComments({})).slice().sort((a, b) => a.seq - b.seq);
  const trace: Record<string, unknown> = {};
  const assetIds = new Set<string>();
  for (const s of sessions) {
    trace[s.id] = await store.listTrace(s.id);
    for (const a of await store.listAssets(s.id)) assetIds.add(a.id);
  }
  const assets = [];
  for (const id of [...assetIds].sort()) assets.push(await store.getAsset(id));
  const settings: Record<string, string | null> = {};
  for (const k of ["theme", "layout", "custom"]) settings[k] = await store.getSetting(k);
  return { sessions, surfaces, comments, trace, assets, settings };
}

const tmpFile = (name: string) => join(mkdtempSync(join(tmpdir(), "sideshow-stress-")), name);
const filePathOf = (s: JsonFileStore) => (s as unknown as { filePath: string }).filePath;

test("migration is byte-faithful across 25 randomized workspaces", async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const json = new JsonFileStore(tmpFile(`workspace-${seed}.json`));
    await buildRandomBoard(json, mulberry32(seed));
    // Snapshot a FRESH reload — that's the on-disk JSON migration actually reads
    // (and it's been through JSON.stringify, which drops `undefined` keys), so
    // the comparison is apples-to-apples rather than against the in-memory build.
    const before = await snapshot(new JsonFileStore(filePathOf(json)));

    const sqlite = new SqlStore(createSqliteStorage());
    await migrateJsonToSqlite(sqlite, filePathOf(json));
    const after = await snapshot(sqlite);

    assert.deepEqual(after, before, `seed ${seed}: migrated snapshot diverged from source`);
  }
});

test("history is capped at HISTORY_LIMIT and the version keeps climbing past it", async () => {
  const json = new JsonFileStore(tmpFile("hist.json"));
  const s = await json.createSession({ agent: "pi" });
  const surf = (await json.createPost({
    sessionId: s.id,
    title: "S",
    surfaces: [{ kind: "html", html: "v0" }] as never,
  }))!;
  for (let i = 1; i <= 30; i++) {
    await json.updatePost(surf.id, { surfaces: [{ kind: "html", html: `v${i}` }] as never });
  }

  const sqlite = new SqlStore(createSqliteStorage());
  await migrateJsonToSqlite(sqlite, filePathOf(json));
  const migrated = (await sqlite.getPost(surf.id))!;

  assert.equal(migrated.version, 31, "version counts every update");
  assert.equal(migrated.history.length, 20, "history capped at HISTORY_LIMIT");
  // the cap keeps the most-recent versions: history holds versions 11..30
  assert.deepEqual(
    migrated.history.map((h) => h.version),
    range(20).map((i) => i + 11),
  );
  assert.equal((migrated.surfaces[0] as { html: string }).html, "v30");
});

test("SqlStore round-trips adversarial text and full-byte binary", async () => {
  const store = new SqlStore(createSqliteStorage());
  // unicode, RTL, emoji ZWJ sequences, control whitespace — all must survive
  const sess = await store.createSession({
    agent: "pi",
    title: "café ☕ 日本語 العربية 🎉👨‍👩‍👧\ttab",
    cwd: "/work/项目",
  });
  const back = (await store.getSession(sess.id))!;
  assert.equal(back.title, "café ☕ 日本語 العربية 🎉👨‍👩‍👧\ttab");
  assert.equal(back.cwd, "/work/项目");

  const surf = (await store.createPost({
    sessionId: sess.id,
    title: "🧵".repeat(50),
    surfaces: [{ kind: "html", html: "<p>日本語 & <b>bold</b> 🎉</p>" }] as never,
  }))!;
  const sr = (await store.getPost(surf.id))!;
  assert.equal(sr.title, "🧵".repeat(50));
  assert.equal((sr.surfaces[0] as { html: string }).html, "<p>日本語 & <b>bold</b> 🎉</p>");

  // SQL-injection-shaped text must be inert (bound param) and survive verbatim
  const evil = `a b'; DROP TABLE comments;-- ☕`;
  await store.createComment({ sessionId: sess.id, author: "user", text: evil });
  const comments = await store.listComments({ sessionId: sess.id });
  assert.equal(comments[0].text, evil);
  assert.equal((await store.listSessions()).length, 1, "comments table still intact");

  // a BLOB containing every byte value 0..255 round-trips exactly
  const allBytes = new Uint8Array(range(256));
  const asset = (await store.putAsset({
    sessionId: sess.id,
    kind: "file",
    contentType: "application/octet-stream",
    data: allBytes,
  }))!;
  const got = (await store.getAsset(asset.id))!;
  assert.deepEqual(Array.from(got.data), range(256));

  // an 8000-char comment (the app's edge cap) stores whole at the store layer
  const big = "x".repeat(8000);
  await store.createComment({ sessionId: sess.id, author: "user", text: big });
  const all = await store.listComments({ sessionId: sess.id });
  assert.equal(all.at(-1)!.text.length, 8000);
});

// SQLite would terminate a TEXT value at the first embedded NUL while the JSON
// store preserves it — so both stores strip NUL (removing the byte, not
// truncating) to stay in lockstep. This pins that they agree, rather than one
// truncating ("keep") and the other preserving ("keep\0dropped").
test("both stores strip an embedded NUL identically — no truncation, no divergence", async () => {
  const json = new JsonFileStore(tmpFile("nul.json"));
  for (const store of [new SqlStore(createSqliteStorage()), json] as const) {
    const s = await store.createSession({
      agent: "pi",
      title: `keep${NUL}dropped`,
      cwd: `/a${NUL}b`,
    });
    const got = (await store.getSession(s.id))!;
    assert.equal(got.title, "keepdropped");
    assert.equal(got.cwd, "/ab");
  }
});

test("concurrent comments get unique, gap-free, increasing seqs", async () => {
  const store = new SqlStore(createSqliteStorage());
  const s = await store.createSession({ agent: "pi" });
  const N = 64;
  const made = await Promise.all(
    range(N).map((i) => store.createComment({ sessionId: s.id, author: "user", text: `c${i}` })),
  );
  const seqs = made.map((c) => c!.seq).sort((a, b) => a - b);
  assert.deepEqual(
    seqs,
    range(N).map((i) => i + 1),
    "seqs are exactly 1..N, no dupes/gaps",
  );
  assert.equal((await store.listComments({ sessionId: s.id })).length, N);
});

test("concurrent updates to one surface stay version-consistent (compare-and-set)", async () => {
  const store = new SqlStore(createSqliteStorage());
  const s = await store.createSession({ agent: "pi" });
  const surf = (await store.createPost({
    sessionId: s.id,
    title: "S",
    surfaces: [{ kind: "html", html: "v0" }] as never,
  }))!;
  const results = await Promise.all(
    range(12).map((i) => store.updatePost(surf.id, { title: `t${i}` })),
  );
  const ok = results.filter(Boolean).length;
  assert.ok(ok >= 1, "at least one update lands");
  const final = (await store.getPost(surf.id))!;
  // exactly `ok` successful bumps → version ok+1, and history is the contiguous
  // run of prior versions (capped at HISTORY_LIMIT) — no lost or torn version.
  assert.equal(final.version, ok + 1);
  const kept = Math.min(ok, 20);
  assert.deepEqual(
    final.history.map((h) => h.version),
    range(kept).map((i) => i + (ok - kept + 1)),
  );
});

test("file-backed SqlStore persists across a reopen of the same db", async () => {
  const dbPath = tmpFile("persist.db");
  let store = new SqlStore(createSqliteStorage(dbPath));
  const s = await store.createSession({ agent: "pi", title: "Persist" });
  const surf = (await store.createPost({
    sessionId: s.id,
    title: "S",
    surfaces: [{ kind: "html", html: "hi" }] as never,
  }))!;
  await store.createComment({ sessionId: s.id, postId: surf.id, author: "user", text: "kept" });
  await store.putAsset({
    sessionId: s.id,
    kind: "file",
    contentType: "text/plain",
    data: new Uint8Array([7, 8, 9]),
  });
  assert.ok(existsSync(dbPath), "db file created");

  // reopen a fresh store on the same file — nothing lost
  store = new SqlStore(createSqliteStorage(dbPath));
  assert.equal((await store.listSessions())[0].title, "Persist");
  const reopened = (await store.getPost(surf.id))!;
  assert.equal(reopened.version, 1);
  assert.equal((reopened.surfaces[0] as { html: string }).html, "hi");
  const cs = await store.listComments({ sessionId: s.id });
  assert.equal(cs[0].text, "kept");
  const assets = await store.listAssets(s.id);
  assert.deepEqual(Array.from((await store.getAsset(assets[0].id))!.data), [7, 8, 9]);
});

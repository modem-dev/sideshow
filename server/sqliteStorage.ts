import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { JsonFileStore } from "./storage.ts";
import { SqlStore } from "./sqlStore.ts";
import type { SqlStorage, SqlStorageCursor, SqlStorageValue } from "./types.ts";

// node:sqlite emits a one-time ExperimentalWarning when the builtin loads. It's
// stable enough for us (the store-contract suite runs SqlStore against it), so
// drop just that line while loading it, then restore the default handler. The
// import is dynamic so the patch is in place first — a static `import` is
// instantiated before any module body runs, too early to intercept. Every other
// warning is untouched.
const defaultEmitWarning = process.emitWarning;
process.emitWarning = function patched(warning: string | Error, ...rest: unknown[]) {
  const message = typeof warning === "string" ? warning : warning.message;
  if (/\bSQLite is an experimental feature\b/.test(message)) return;
  (defaultEmitWarning as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
} as typeof process.emitWarning;
// finally so the original handler is restored even if the import rejects (e.g.
// a Node build without node:sqlite) — otherwise the patch would leak and
// silently swallow later SQLite warnings from elsewhere.
let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} finally {
  process.emitWarning = defaultEmitWarning;
}

function makeCursor(rows: Record<string, SqlStorageValue>[]): SqlStorageCursor {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
      return rows[0];
    },
  };
}

// A `SqlStorage` (the slice of a Durable Object's SQL API that SqlStore uses)
// backed by Node's built-in node:sqlite. Lets the SAME SqlStore run locally
// that runs on the Worker DO, so the two deploys exercise one storage code
// path. `:memory:` (the default) backs the store-contract suite; a file path is
// the real local store.
export function createSqliteStorage(path = ":memory:"): SqlStorage {
  if (path !== ":memory:") {
    // node:sqlite won't create missing parent directories — it just fails with
    // "unable to open database file". The default db path lives under the
    // package dir (no `data/` shipped), so the first run would always crash.
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    // WAL + NORMAL: durable across a crash, far fewer fsyncs than the default
    // — the right tradeoff for a single-process local server.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  return {
    exec(query, ...bindings) {
      // Schema DDL (multi-statement) and transaction control can't be run as a
      // bound prepared statement — hand them to db.exec() directly. Everything
      // else is a single prepared statement, matching the DO's exec(). The
      // `bindings.length === 0` guard relies on SqlStore never issuing a
      // zero-binding query that contains a literal `;` (it inlines no values —
      // every dynamic value is a bound `?`), so a semicolon only ever means DDL.
      const control =
        bindings.length === 0 &&
        (/;\s*\S/.test(query) || /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(query));
      if (control) {
        db.exec(query);
        return makeCursor([]);
      }
      // node:sqlite binds blobs as Uint8Array; the SqlStorage contract passes
      // them as ArrayBuffer — adapt so BLOB columns round-trip.
      const params = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as (
        | string
        | number
        | null
        | Uint8Array
      )[];
      const rows = db.prepare(query).all(...params) as Record<string, SqlStorageValue>[];
      return makeCursor(rows);
    },
  };
}

// One-time migration: if `sqlite` is empty and a legacy JSON store exists at
// `jsonPath`, copy the whole workspace in. Idempotent — a sentinel setting records
// that we've run, and we never import into a non-empty db — so it's safe to
// call on every boot. The JSON file is read-only here and left in place as a
// backup.
export async function migrateJsonToSqlite(sqlite: SqlStore, jsonPath: string): Promise<void> {
  if ((await sqlite.getSetting("importedFrom")) != null) return;
  if ((await sqlite.listSessions()).length > 0) {
    await sqlite.setSetting("importedFrom", "(skipped: db already had data)");
    return;
  }
  if (!existsSync(jsonPath)) return;
  // A corrupt/truncated JSON file (e.g. a crash mid-write) must not crash the
  // server on boot. Warn, leave the file untouched, and don't set the sentinel
  // — so a later fixed file still migrates — and boot with an empty SQLite db
  // rather than failing to start at all.
  let snapshot;
  try {
    snapshot = await new JsonFileStore(jsonPath).exportBoard();
  } catch (e) {
    console.error(
      `[sideshow] could not read ${jsonPath} to migrate it into SQLite ` +
        `(${e instanceof Error ? e.message : e}); leaving it untouched and ` +
        `starting with an empty SQLite store. Fix or remove the file to retry.`,
    );
    return;
  }
  sqlite.importBoard(snapshot);
  await sqlite.setSetting("importedFrom", jsonPath);
  const posts = snapshot.posts ?? snapshot.surfaces ?? [];
  if (snapshot.sessions.length || posts.length) {
    console.error(
      `[sideshow] migrated ${snapshot.sessions.length} session(s), ` +
        `${posts.length} post(s), ${snapshot.comments.length} comment(s), ` +
        `${snapshot.assets.length} asset(s) from ${jsonPath} into SQLite`,
    );
  }
}

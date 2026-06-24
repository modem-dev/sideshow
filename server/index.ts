import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { SqlStore } from "./sqlStore.ts";
import { createSqliteStorage, migrateJsonToSqlite } from "./sqliteStorage.ts";
import { JsonFileStore } from "./storage.ts";
import type { Store } from "./types.ts";

// Source layout puts this file at server/index.ts; the published package runs
// the compiled copy at dist/server/index.js. viewer/ and guide/ live at the
// package root either way.
let root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (basename(root) === "dist") root = join(root, "..");

const [viewerHtml, guideMarkdown, setupText, agentHowtoText, pkgJson] = await Promise.all([
  readFile(join(root, "viewer", "dist", "index.html"), "utf8").catch(() => {
    console.error("viewer build missing — run `npm run build:viewer` first");
    return process.exit(1);
  }),
  readFile(join(root, "guide", "DESIGN_GUIDE.md"), "utf8"),
  readFile(join(root, "guide", "AGENT_SETUP.md"), "utf8"),
  readFile(join(root, "guide", "AGENT_HOWTO.md"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
]);

const pr = process.env.SIDESHOW_PUBLIC_READ;
const publicRead = pr === "session" || pr === "full" ? pr : undefined;

// Storage backend. SQLite (via node:sqlite) is the default so the local server
// mirrors the Cloudflare Durable Object deploy — both run the same SqlStore.
// SIDESHOW_STORE=json selects the legacy single-file JSON store instead.
// SIDESHOW_DATA names the JSON file (and the one-time migration source);
// SIDESHOW_DB names the SQLite file.
const jsonPath = process.env.SIDESHOW_DATA ?? join(root, "data", "sideshow.json");
// The SQLite file defaults next to the JSON one (same dir, `.db` suffix) so a
// deploy that only sets SIDESHOW_DATA still gets an isolated, co-located db —
// and the migration source sits right beside it.
const dbPath = process.env.SIDESHOW_DB ?? `${jsonPath.replace(/\.json$/, "")}.db`;
let store: Store;
if (process.env.SIDESHOW_STORE === "json") {
  store = new JsonFileStore(jsonPath);
  console.log(`sideshow store: JSON file at ${jsonPath}`);
} else {
  const sqlite = new SqlStore(createSqliteStorage(dbPath));
  // First SQLite boot with a legacy JSON file present copies it in once.
  await migrateJsonToSqlite(sqlite, jsonPath);
  store = sqlite;
  // Announce the backend so an existing SIDESHOW_DATA deploy isn't surprised by
  // the silent switch to SQLite (set SIDESHOW_STORE=json to keep the old store).
  console.log(
    `sideshow store: SQLite at ${dbPath} (SIDESHOW_STORE=json for the legacy JSON store)`,
  );
}

const app = createApp({
  store,
  viewerHtml,
  guideMarkdown,
  setupText,
  agentHowtoText,
  authToken: process.env.SIDESHOW_TOKEN,
  publicRead,
  // SIDESHOW_VERSION fakes the running version (manual testing of the
  // notice); set it to the empty string to disable the update check
  version: process.env.SIDESHOW_VERSION ?? (JSON.parse(pkgJson) as { version: string }).version,
  upgradeCommand: "npm install -g sideshow",
});

const port = Number(process.env.PORT ?? 8228);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`sideshow listening on http://localhost:${info.port}`);
});

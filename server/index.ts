import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { JsonFileStore } from "./storage.ts";

// Source layout puts this file at server/index.ts; the published package runs
// the compiled copy at dist/server/index.js. viewer/ and guide/ live at the
// package root either way.
let root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (basename(root) === "dist") root = join(root, "..");

const [viewerHtml, guideMarkdown, setupText] = await Promise.all([
  readFile(join(root, "viewer", "index.html"), "utf8"),
  readFile(join(root, "guide", "DESIGN_GUIDE.md"), "utf8"),
  readFile(join(root, "guide", "AGENT_SETUP.md"), "utf8"),
]);

function defaultDataFile() {
  if (process.env.SIDESHOW_DATA) return process.env.SIDESHOW_DATA;
  if (process.env.XDG_DATA_HOME)
    return join(process.env.XDG_DATA_HOME, "sideshow", "sideshow.json");
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "sideshow", "sideshow.json");
  }
  return join(homedir(), ".local", "share", "sideshow", "sideshow.json");
}

const app = createApp({
  store: new JsonFileStore(defaultDataFile()),
  viewerHtml,
  guideMarkdown,
  setupText,
  authToken: process.env.SIDESHOW_TOKEN,
});

const port = Number(process.env.PORT ?? 4242);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`sideshow listening on http://localhost:${info.port}`);
});

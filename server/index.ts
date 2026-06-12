import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
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
  readFile(join(root, "viewer", "dist", "index.html"), "utf8").catch(() => {
    console.error("viewer build missing — run `npm run build:viewer` first");
    return process.exit(1);
  }),
  readFile(join(root, "guide", "DESIGN_GUIDE.md"), "utf8"),
  readFile(join(root, "guide", "AGENT_SETUP.md"), "utf8"),
]);

const app = createApp({
  store: new JsonFileStore(process.env.SIDESHOW_DATA ?? join(root, "data", "sideshow.json")),
  viewerHtml,
  guideMarkdown,
  setupText,
  authToken: process.env.SIDESHOW_TOKEN,
});

const port = Number(process.env.PORT ?? 4242);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`sideshow listening on http://localhost:${info.port}`);
});

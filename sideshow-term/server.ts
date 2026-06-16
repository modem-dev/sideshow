// sideshow-term server. It reuses sideshow's runtime-agnostic core verbatim
// (createApp + JsonFileStore) — snippets are opaque strings to the store, so
// the same REST API, SSE feed and long-poll serve STML just as well as HTML.
// What differs is the agent-facing contract: /guide and /setup teach the
// opentui markup, not browser HTML, and the viewer is the TUI (`watch`), not
// a browser, so we hand createApp a placeholder landing page.
//
// Runs on Node (hono). The opentui pieces run on Bun; the two never share a
// process.

import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/app.ts";
import { JsonFileStore } from "../server/storage.ts";

const root = dirname(fileURLToPath(import.meta.url));

const [guideMarkdown, setupText, pkgJson] = await Promise.all([
  readFile(join(root, "guide", "DESIGN_GUIDE.md"), "utf8"),
  readFile(join(root, "guide", "AGENT_SETUP.md"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
]);

const landing = `<!doctype html><meta charset="utf-8"><title>sideshow-term</title>
<body style="font:16px/1.6 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>sideshow-term</h1>
<p>This is a terminal visual surface. There is no browser viewer — open the
live viewer in a terminal:</p>
<pre style="background:#f4f4f5;padding:1rem;border-radius:8px">sideshow-term watch</pre>
<p>Agents publish opentui markup; see <a href="/guide">/guide</a> and
<a href="/setup">/setup</a>.</p>
</body>`;

const app = createApp({
  store: new JsonFileStore(process.env.SIDESHOW_DATA ?? join(root, "data", "sideshow-term.json")),
  viewerHtml: landing,
  guideMarkdown,
  setupText,
  authToken: process.env.SIDESHOW_TOKEN,
  version: (JSON.parse(pkgJson) as { version: string }).version,
  upgradeCommand: "npm install -g sideshow-term",
  // sideshow-term isn't on npm under sideshow's name; skip the update probe.
  fetchLatestRelease: async () => null,
});

const port = Number(process.env.PORT ?? 4242);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`sideshow-term listening on http://localhost:${info.port}`);
  console.log(`open the live viewer in a terminal:  sideshow-term watch`);
});

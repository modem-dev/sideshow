// End-to-end browser proof of the embeddable engine's stream-only + read-only
// layout driven THROUGH THE HOST CONTRACT (host.layout / host.readonly), not the
// self-hosted window globals. This is the path the sideshow cloud's shared-link
// guest view uses.
//
// We serve a tiny embed page and the built dist-embed bundle on the sideshow
// server's own origin (via route fulfillment) so the engine's same-origin
// /api/* calls hit the real server with real data. The engine attaches an OPEN
// shadow root, which Playwright CSS locators pierce — so we can assert the
// rendered layout, not just "it mounted".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, publish, test } from "./fixtures.ts";

const embedDir = fileURLToPath(new URL("../viewer/dist-embed", import.meta.url));

function contentType(path: string): string {
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".css")) return "text/css";
  return "application/octet-stream";
}

const embedHtml = (sessionId: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#m{position:fixed;inset:0}</style></head>
<body><div id="m"></div>
<script type="module">
  import { mountViewer } from "/__embed/engine.js";
  mountViewer(document.getElementById("m"), {
    basePath: "",
    layout: "stream",
    readonly: true,
    router: {
      get: () => ({ sessionId: ${JSON.stringify(sessionId)} }),
      navigate() {},
      subscribe() { return () => {}; },
    },
  });
</script></body></html>`;

test("embedded engine: host layout:'stream' renders no sidebar, readonly hides write controls", async ({
  page,
  server,
}) => {
  // The `server` fixture runs tokenless, so the engine's same-origin /api/*
  // reads are open — this test is about layout, not auth.
  const surface = await publish(
    server.url,
    { html: "<p>embedded stream card</p>", title: "Embedded stream", agent: "e2e" },
    "",
  );

  // Surface engine load/runtime errors instead of a bare "element not found".
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("[console]", m.text()));

  // Serve the embed page and the built engine + its lazy chunks on the server
  // origin (relative `./chunk-*.js` imports resolve under /__embed/).
  await page.route("**/__embedtest", (route) =>
    route.fulfill({ contentType: "text/html", body: embedHtml(surface.sessionId) }),
  );
  await page.route("**/__embed/**", (route) => {
    const name = new URL(route.request().url()).pathname.replace("/__embed/", "");
    route.fulfill({ contentType: contentType(name), body: readFileSync(`${embedDir}/${name}`) });
  });

  await page.goto(`${server.url}/__embedtest`);

  // The shared session's stream renders inside the engine's shadow root.
  const card = page.locator(".card:not(#whatsNew)");
  await expect(card).toBeVisible();
  await expect(page.locator(".card-title")).toContainText("Embedded stream");

  // layout:"stream" via the host → no sidebar / session-list chrome.
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(page.locator("button.menu")).toHaveCount(0);
  await expect(page.locator("#scrim")).toHaveCount(0);
  await expect(page.locator("#onboard")).toHaveCount(0);

  // readonly:true via the host → write controls gone, read actions kept.
  await expect(card.locator(".act.del")).toHaveCount(0);
  await expect(card.locator(".act.comment")).toHaveCount(0);
  await expect(card.locator(".act.copy")).toBeVisible();
});

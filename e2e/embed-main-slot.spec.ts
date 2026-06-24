// End-to-end browser proof that an embedder can take over the engine's MAIN
// content pane through the shadow boundary via the `ss:main` slot — the seam the
// sideshow cloud uses to render its full-page "Settings" view in the main area
// while the engine's sidebar (session list + account footer) stays put.
//
// Same harness as embed-slots.spec.ts. We mount in the default "full" layout with
// a real session in view, and project a light-DOM `<div slot="ss:main">` child of
// the mount element. The engine's <slot name="ss:main"> projects it in place of
// the board, so the host pane shows and the engine's own #stream does not.
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
<body><div id="m"><div slot="ss:main" id="hostMain"><h2>Host settings pane</h2></div></div>
<script type="module">
  import { mountViewer } from "/__embed/engine.js";
  mountViewer(document.getElementById("m"), {
    basePath: "",
    router: {
      get: () => ({ sessionId: ${JSON.stringify(sessionId)} }),
      navigate() {},
      subscribe() { return () => {}; },
    },
  });
</script></body></html>`;

test("embedded engine: ss:main slot takes over the main pane while the sidebar stays", async ({
  page,
  server,
}) => {
  const surface = await publish(
    server.url,
    { html: "<p>board card</p>", title: "Board card", agent: "e2e" },
    "",
  );

  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("[console]", m.text()));

  await page.route("**/__embedtest", (route) =>
    route.fulfill({ contentType: "text/html", body: embedHtml(surface.sessionId) }),
  );
  await page.route("**/__embed/**", (route) => {
    const name = new URL(route.request().url()).pathname.replace("/__embed/", "");
    route.fulfill({ contentType: contentType(name), body: readFileSync(`${embedDir}/${name}`) });
  });

  await page.goto(`${server.url}/__embedtest`);

  // The host's light-DOM pane projects into the main slot and is visible.
  const hostMain = page.locator("#hostMain");
  await expect(hostMain).toBeVisible();
  await expect(page.locator("main slot[name='ss:main']")).toHaveCount(1);

  // The sidebar (full layout) stays — the override is the main pane only, not the
  // whole viewport.
  await expect(page.locator("aside")).toBeVisible();

  // The engine's own board content is replaced: with a child assigned to ss:main,
  // the slot's fallback (#sessionView stream) stays in the DOM — native <slot>
  // mechanics — but is not displayed, so the host pane is what the user sees.
  await expect(page.locator("#stream")).toBeHidden();
});

// End-to-end browser proof that an embedder can project content into the engine's
// host-overridable slots THROUGH the shadow boundary — specifically the
// `ss:session-actions` region in the session header (beside the stream/timeline
// toggle), which the sideshow cloud uses for its "Share" button.
//
// Same harness as embed-stream.spec.ts: the embed page + built dist-embed bundle
// are served on the server's own origin so same-origin /api/* reads hit real data.
// We mount in the default "full" layout and add a light-DOM `<div slot=...>` child
// of the mount element; the engine's <slot> projects it into the session header.
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
<body><div id="m"><button slot="ss:session-actions" id="cloudShare">Share</button></div>
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

test("embedded engine: ss:session-actions slot projects host content into the session header", async ({
  page,
  server,
}) => {
  const surface = await publish(
    server.url,
    { html: "<p>slot card</p>", title: "Slot card", agent: "e2e" },
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

  // The session header (with the stream/timeline toggle) renders in "full" layout.
  const head = page.locator(".session-head");
  await expect(head).toBeVisible();
  await expect(head.locator(".view-toggle")).toBeVisible();

  // The host's light-DOM button projects into the session-actions slot, landing
  // inside the engine's header next to the toggle — and is the embedder's element,
  // not the engine's.
  const share = page.locator("#cloudShare");
  await expect(share).toBeVisible();
  await expect(head.locator("slot[name='ss:session-actions']")).toHaveCount(1);
});

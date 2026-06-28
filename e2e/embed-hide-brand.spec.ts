// End-to-end proof of the `hideBrand` host flag: an embedder that supplies its own
// branding can suppress the engine's "sideshow" wordmark. With the flag off
// (self-hosted default) the wordmark renders as before, so parity holds.
//
// Same harness as embed-main-slot.spec.ts.
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

const embedHtml = (hideBrand: boolean) => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#m{position:fixed;inset:0}</style></head>
<body><div id="m"></div>
<script type="module">
  import { mountViewer } from "/__embed/engine.js";
  mountViewer(document.getElementById("m"), {
    basePath: "",
    hideBrand: ${hideBrand ? "true" : "false"},
    router: { get: () => ({ sessionId: null }), navigate() {}, subscribe() { return () => {}; } },
  });
</script></body></html>`;

async function mount(page: import("@playwright/test").Page, serverUrl: string, hideBrand: boolean) {
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  const path = `/__embedtest-brand-${hideBrand ? "off" : "on"}`;
  await page.route(`**${path}`, (route) =>
    route.fulfill({ contentType: "text/html", body: embedHtml(hideBrand) }),
  );
  await page.route("**/__embed/**", (route) => {
    const name = new URL(route.request().url()).pathname.replace("/__embed/", "");
    route.fulfill({ contentType: contentType(name), body: readFileSync(`${embedDir}/${name}`) });
  });
  await page.goto(`${serverUrl}${path}`);
}

test("hideBrand: true suppresses the engine wordmark", async ({ page, server }) => {
  await publish(server.url, { html: "<p>card</p>", title: "Seeded", agent: "e2e" }, "");
  await mount(page, server.url, true);
  await expect(page.locator("aside")).toBeVisible();
  await expect(page.locator(".brand")).toHaveCount(0);
});

test("hideBrand off (self-hosted default): the wordmark renders", async ({ page, server }) => {
  await publish(server.url, { html: "<p>card</p>", title: "Seeded", agent: "e2e" }, "");
  await mount(page, server.url, false);
  await expect(page.locator("aside .brand")).toBeVisible();
});

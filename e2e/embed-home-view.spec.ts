// End-to-end browser proof of the `homeView` host flag: when an embedder owns its
// own session-less landing (e.g. sideshow cloud's "Home" feed), the engine must NOT
// auto-pick a session on boot — it stays session-less so nothing is highlighted
// behind the host's landing. With the flag OFF (self-hosted default) the engine
// auto-selects the latest session exactly as before, so parity is preserved.
//
// Same harness as embed-main-slot.spec.ts: publish a real surface (which creates a
// session), then mount the engine with a router whose route carries NO session
// (`sessionId: null`) — the host's home state — and toggle `homeView`.
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

// Mount with a session-less route (the host's home state) and a togglable homeView.
const embedHtml = (homeView: boolean) => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#m{position:fixed;inset:0}</style></head>
<body><div id="m"></div>
<script type="module">
  import { mountViewer } from "/__embed/engine.js";
  mountViewer(document.getElementById("m"), {
    basePath: "",
    homeView: ${homeView ? "true" : "false"},
    router: {
      get: () => ({ sessionId: null }),
      navigate() {},
      subscribe() { return () => {}; },
    },
  });
</script></body></html>`;

async function mount(page: import("@playwright/test").Page, serverUrl: string, homeView: boolean) {
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("[console]", m.text()));
  const path = `/__embedtest-home-${homeView ? "on" : "off"}`;
  await page.route(`**${path}`, (route) =>
    route.fulfill({ contentType: "text/html", body: embedHtml(homeView) }),
  );
  await page.route("**/__embed/**", (route) => {
    const name = new URL(route.request().url()).pathname.replace("/__embed/", "");
    route.fulfill({ contentType: contentType(name), body: readFileSync(`${embedDir}/${name}`) });
  });
  await page.goto(`${serverUrl}${path}`);
}

test("homeView: a session-less route lands with NO session selected", async ({ page, server }) => {
  // Seed a real session so the sidebar has something to (not) select.
  await publish(server.url, { html: "<p>card</p>", title: "Seeded", agent: "e2e" }, "");

  await mount(page, server.url, true);

  // The session loads into the sidebar...
  await expect(page.locator("aside .sess").first()).toBeVisible();
  // ...but none is selected, and the engine never auto-opened the session (its
  // post cards aren't loaded — the stream stays empty behind the host's home).
  await expect(page.locator(".sess.sel")).toHaveCount(0);
  await expect(page.locator(".sess[aria-current='true']")).toHaveCount(0);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(0);
});

test("homeView OFF (self-hosted default): a session-less route auto-selects the latest", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>card</p>", title: "Seeded", agent: "e2e" }, "");

  await mount(page, server.url, false);

  // Parity: with the flag off the engine auto-selects the one session and opens it.
  await expect(page.locator(".sess.sel")).toHaveCount(1);
  await expect(page.locator("#stream")).toBeVisible();
});

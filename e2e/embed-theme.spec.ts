// End-to-end proof of the Host contract's `onThemeChange` push: the engine TELLS
// the host its resolved palette (on mount, and on every live theme switch) so an
// embedder mirrors the colors onto its own chrome WITHOUT scraping computed
// styles across the shadow boundary. This is the path the sideshow cloud chrome
// uses to stay aligned with the viewer.
//
// Harness mirrors embed-stream.spec.ts: serve a tiny embed page + the built
// dist-embed bundle on the server's own origin so the engine's same-origin
// /api/* calls hit real data. The injected host stashes each pushed palette on
// `window.__tokens` so the test can assert what the engine sent.
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

// Default (full) layout so the engine's theme picker (#themeSel) is present. The
// host records every onThemeChange payload and a call count on window.
const embedHtml = (sessionId: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#m{position:fixed;inset:0}</style></head>
<body><div id="m"></div>
<script type="module">
  import { mountViewer } from "/__embed/engine.js";
  window.__themeCalls = 0;
  mountViewer(document.getElementById("m"), {
    basePath: "",
    router: {
      get: () => ({ sessionId: ${JSON.stringify(sessionId)} }),
      navigate() {},
      subscribe() { return () => {}; },
    },
    onThemeChange(tokens) { window.__themeCalls++; window.__tokens = tokens; },
  });
</script></body></html>`;

test("embedded engine pushes the resolved palette to the host on mount and on theme switch", async ({
  page,
  server,
}) => {
  const surface = await publish(
    server.url,
    { html: "<p>themed embed card</p>", title: "Themed embed", agent: "e2e" },
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
  await expect(page.locator(".card:not(#whatsNew)")).toBeVisible();

  // On mount the engine resolves + pushes the default (github) light palette.
  await expect.poll(() => page.evaluate(() => window.__tokens?.["--bg"])).toBe("#f6f8fa");
  await expect.poll(() => page.evaluate(() => window.__tokens?.["--accent"])).toBe("#0969da");
  const callsAfterMount = await page.evaluate(() => window.__themeCalls);
  expect(callsAfterMount).toBeGreaterThan(0);

  // Switching the theme via the engine's own picker pushes the new palette —
  // no host-side scraping involved.
  await page.locator("#themeSel").selectOption("gruvbox");
  await expect.poll(() => page.evaluate(() => window.__tokens?.["--bg"])).toBe("#f9f5d7");
  expect(await page.evaluate(() => window.__themeCalls)).toBeGreaterThan(callsAfterMount);
});

declare global {
  interface Window {
    __themeCalls: number;
    __tokens?: Record<string, string>;
  }
}

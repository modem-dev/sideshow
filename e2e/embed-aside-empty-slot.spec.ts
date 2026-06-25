// End-to-end browser proof for the `ss:aside-empty` slot — the empty-sidebar
// affordance shown in the session list when no sessions exist. The fallback is
// a native "Connect an agent" row; an embedder projects a `slot="ss:aside-empty"`
// child to replace it. Same embed harness as embed-slots.spec.ts: the embed page
// + built dist-embed bundle are served on the server's own origin so same-origin
// /api/* reads hit real data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, publish, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const embedDir = fileURLToPath(new URL("../viewer/dist-embed", import.meta.url));

function contentType(path: string): string {
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".css")) return "text/css";
  return "application/octet-stream";
}

// Mounts the engine in "full" layout over an empty board. `slotChild` is the
// light-DOM child (with a slot= attribute) projected into the mount element, or
// none. The router points at no session so the empty board shows.
const embedHtml = (slotChild: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#m{position:fixed;inset:0}</style></head>
<body><div id="m">${slotChild}</div>
<script type="module">
  import { mountViewer } from "/__embed/engine.js";
  mountViewer(document.getElementById("m"), {
    basePath: "",
    router: {
      get: () => ({}),
      navigate() {},
      subscribe() { return () => {}; },
    },
  });
</script></body></html>`;

// Same harness, but routing to a real session so the sidebar lists it.
const embedHtmlWithSession = (sessionId: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#m{position:fixed;inset:0}</style></head>
<body><div id="m"></div>
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

function serveEmbed(page: Page, html: string) {
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("[console]", m.text()));
  return Promise.all([
    page.route("**/__embedtest", (route) =>
      route.fulfill({ contentType: "text/html", body: html }),
    ),
    page.route("**/__embed/**", (route) => {
      const name = new URL(route.request().url()).pathname.replace("/__embed/", "");
      route.fulfill({ contentType: contentType(name), body: readFileSync(`${embedDir}/${name}`) });
    }),
  ]);
}

test.describe("embedded engine: ss:aside-empty slot", () => {
  test("fallback 'Connect an agent' row renders when nothing is projected and there are no sessions", async ({
    page,
    server,
  }) => {
    await serveEmbed(page, embedHtml(""));
    await page.goto(`${server.url}/__embedtest`);

    // The sidebar (full layout) renders with an empty session list.
    await expect(page.locator("aside")).toBeVisible();

    // The native fallback affordance renders as the first list row, with its
    // label and helper text.
    const row = page.locator(".aside-empty");
    await expect(row).toBeVisible();
    await expect(row).toContainText("Connect an agent");
    await expect(row).toContainText("Your sessions will appear here once an agent connects.");
    await expect(page.locator("aside slot[name='ss:aside-empty']")).toHaveCount(1);
  });

  test("projected content replaces the fallback through the shadow boundary", async ({
    page,
    server,
  }) => {
    await serveEmbed(
      page,
      embedHtml('<div slot="ss:aside-empty" id="hostEmpty">host empty nudge</div>'),
    );
    await page.goto(`${server.url}/__embedtest`);

    // The host's light-DOM projection shows in place of the native fallback.
    const hostEmpty = page.locator("#hostEmpty");
    await expect(hostEmpty).toBeVisible();
    await expect(hostEmpty).toContainText("host empty nudge");

    // The engine's fallback row is present in the DOM (native <slot> default
    // content) but not rendered — the projection is what the user sees.
    await expect(page.locator(".aside-empty")).toBeHidden();
  });

  test("neither fallback nor projection renders once a session exists", async ({
    page,
    server,
  }) => {
    const surface = await publish(
      server.url,
      { html: "<p>board card</p>", title: "Board card", agent: "e2e" },
      "",
    );

    await serveEmbed(page, embedHtmlWithSession(surface.sessionId));
    await page.goto(`${server.url}/__embedtest`);

    // A real session row shows in the sidebar …
    await expect(page.locator("aside .sess")).toBeVisible();

    // … and the empty-sidebar affordance is gone entirely (the gating <Show>
    // removes the slot + fallback when sessions exist).
    await expect(page.locator(".aside-empty")).toHaveCount(0);
    await expect(page.locator("aside slot[name='ss:aside-empty']")).toHaveCount(0);
  });
});

// End-to-end browser proof for the `ss:aside-head` slot — the host-overridable
// region at the top of the sidebar, above the session list. Empty by default
// (self-hosted shows nothing here); an embedder projects a `slot="ss:aside-head"`
// child to render its own sidebar header. Same embed harness as
// embed-aside-empty-slot.spec.ts: the embed page + built dist-embed bundle are
// served on the server's own origin so same-origin /api/* reads hit real data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.ts";
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
// none. The router points at no session so the board renders the sidebar.
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

test.describe("embedded engine: ss:aside-head slot", () => {
  test("nothing is injected when no header is projected (self-hosted parity)", async ({
    page,
    server,
  }) => {
    await serveEmbed(page, embedHtml(""));
    await page.goto(`${server.url}/__embedtest`);

    // The sidebar (full layout) renders normally, with the Brand wordmark.
    await expect(page.locator("aside")).toBeVisible();
    await expect(page.locator("aside .brand")).toBeVisible();

    // The slot is mounted (so an embedder can project into it) but it carries no
    // fallback children — nothing is shown above the session list by default.
    await expect(page.locator("aside slot[name='ss:aside-head']")).toHaveCount(1);
    await expect(page.locator("#hostHead")).toHaveCount(0);
  });

  test("projected header renders above the session list through the shadow boundary", async ({
    page,
    server,
  }) => {
    await serveEmbed(page, embedHtml('<div slot="ss:aside-head" id="hostHead">host header</div>'));
    await page.goto(`${server.url}/__embedtest`);

    // The host's light-DOM projection shows.
    const hostHead = page.locator("#hostHead");
    await expect(hostHead).toBeVisible();
    await expect(hostHead).toContainText("host header");

    // It sits ABOVE the session list — its top edge is above #sessionList's top.
    const headBox = await hostHead.boundingBox();
    const listBox = await page.locator("aside #sessionList").boundingBox();
    expect(headBox).not.toBeNull();
    expect(listBox).not.toBeNull();
    expect(headBox!.y).toBeLessThan(listBox!.y);

    // Collapsing hides host-projected sidebar content without unmounting it;
    // expanding restores the projection intact.
    const aside = page.locator("aside");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(aside).toHaveCSS("width", "40px");
    await expect(hostHead).toBeHidden();
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(aside).toHaveCSS("width", "248px");
    await expect(hostHead).toBeVisible();
  });
});

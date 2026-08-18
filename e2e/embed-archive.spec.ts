// The archive route is part of the embeddable engine contract: a host owns the
// route and the engine both renders it when received and requests it when the
// compact sidebar's archive link is activated.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.ts";

const embedDir = fileURLToPath(new URL("../viewer/dist-embed", import.meta.url));

function contentType(path: string): string {
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
  return "application/octet-stream";
}

const embedHtml = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#m{position:fixed;inset:0}</style></head>
<body><div id="m"></div>
<script type="module">
  import { mountViewer } from "/__embed/engine.js";
  let route = { archives: true, surfaceId: "stale-post-id" };
  const subscribers = new Set();
  window.__archiveRoute = (next) => {
    route = next;
    for (const subscriber of subscribers) subscriber(route);
  };
  mountViewer(document.getElementById("m"), {
    basePath: "",
    router: {
      get: () => route,
      navigate: (next) => {
        window.__archiveNavigation = next;
        window.__archiveRoute(next);
      },
      subscribe: (subscriber) => {
        subscribers.add(subscriber);
        return () => subscribers.delete(subscriber);
      },
    },
  });
</script></body></html>`;

test("embedded routers receive and navigate to the archive route", async ({ page, server }) => {
  await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      fetch(`${server.url}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "embed", title: `Archive ${index}` }),
      }),
    ),
  );
  await page.route("**/__embed-archive", (route) =>
    route.fulfill({ contentType: "text/html", body: embedHtml }),
  );
  await page.route("**/__embed/**", (route) => {
    const name = new URL(route.request().url()).pathname.replace("/__embed/", "");
    route.fulfill({ contentType: contentType(name), body: readFileSync(`${embedDir}/${name}`) });
  });
  await page.goto(`${server.url}/__embed-archive`);

  // The host's initial { archives: true } route reaches the archive UI.
  await expect(page.getByRole("heading", { name: "Archives" })).toBeVisible();

  // Then the host moves to its normal workspace route; the engine restores the
  // compact sidebar and asks the host for { archives: true } when activated.
  await page.evaluate(() => {
    (window as unknown as { __archiveRoute: (route: object) => void }).__archiveRoute({});
  });
  await expect(page.locator("#sessionList .sess")).toHaveCount(15);

  // Hosts can retain optional route fields while changing views. `archives`
  // wins over a stale surfaceId instead of entering standalone-post mode.
  await page.evaluate(() => {
    (window as unknown as { __archiveRoute: (route: object) => void }).__archiveRoute({
      archives: true,
      surfaceId: "stale-post-id",
    });
  });
  await expect(page.getByRole("heading", { name: "Archives" })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __archiveRoute: (route: object) => void }).__archiveRoute({});
  });
  await expect(page.locator("#sessionList .sess")).toHaveCount(15);
  await page.getByRole("button", { name: /Go to archives 16/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __archiveNavigation?: { archives?: boolean } })
            .__archiveNavigation?.archives,
      ),
    )
    .toBe(true);
});

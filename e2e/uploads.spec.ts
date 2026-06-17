import { expect, publish, publishParts, test, TINY_PNG_B64, upload } from "./fixtures.ts";

test("an image part renders an <img> served from /a/:id", async ({ page, server }) => {
  const asset = await upload(server.url, {
    data: TINY_PNG_B64,
    contentType: "image/png",
    filename: "pixel.png",
    kind: "image",
  });
  await publishParts(server.url, {
    title: "A screenshot",
    agent: "e2e",
    session: asset.sessionId,
    parts: [{ kind: "image", assetId: asset.id, caption: "one pixel" }],
  });

  await page.goto(server.url);
  const img = page.locator(".card .asset-img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", `/a/${asset.id}`);
  // the bytes actually loaded (not a broken image)
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  await expect(page.locator(".asset-caption")).toHaveText("one pixel");
});

test("a trace part renders a step timeline with expandable detail", async ({ page, server }) => {
  await publishParts(server.url, {
    title: "Run trace",
    agent: "e2e",
    parts: [
      {
        kind: "trace",
        title: "What I did",
        steps: [
          { label: "read server/app.ts", kind: "tool", detail: "opened the file at line 1" },
          { label: "thinking about the fix" },
        ],
      },
    ],
  });

  await page.goto(server.url);
  const card = page.locator(".card");
  await expect(card.locator(".trace-title")).toHaveText("What I did");
  await expect(card.locator(".trace-step")).toHaveCount(2);
  await expect(card.locator(".trace-kind").first()).toHaveText("tool");

  // the step with a detail expands on click; the label-only one has no detail
  await expect(card.locator(".trace-detail")).toHaveCount(0);
  await card.locator(".trace-row.clickable").first().click();
  await expect(card.locator(".trace-detail")).toHaveText("opened the file at line 1");
});

test("a trace part backed by an uploaded file offers a download and renders steps", async ({
  page,
  server,
}) => {
  const jsonl = '{"label":"step one","kind":"shell"}\n{"label":"step two"}';
  const asset = await upload(server.url, {
    data: Buffer.from(jsonl).toString("base64"),
    contentType: "application/x-ndjson",
    filename: "trace.jsonl",
    kind: "trace",
  });
  await publishParts(server.url, {
    title: "Uploaded trace",
    agent: "e2e",
    session: asset.sessionId,
    parts: [{ kind: "trace", assetId: asset.id }],
  });

  await page.goto(server.url);
  const card = page.locator(".card");
  await expect(card.locator(".trace-dl")).toHaveAttribute("href", `/a/${asset.id}`);
  // steps are fetched from the asset and rendered
  await expect(card.locator(".trace-step")).toHaveCount(2);
  await expect(card.locator(".trace-label").first()).toHaveText("step one");
});

test("an uploaded image embeds by URL inside an html part under the CSP", async ({
  page,
  server,
}) => {
  const asset = await upload(server.url, {
    data: TINY_PNG_B64,
    contentType: "image/png",
    kind: "image",
  });
  await publish(server.url, {
    html: `<img id="embed" src="/a/${asset.id}">`,
    title: "Embedded",
    agent: "e2e",
    session: asset.sessionId,
  });

  // The sandboxed iframe runs at an opaque origin; the surface CSP now allows
  // the server origin, so the <img> request goes out. If the CSP blocked it the
  // request would never be made and this would time out.
  const assetResponse = page.waitForResponse(
    (r) => r.url().endsWith(`/a/${asset.id}`) && r.status() === 200,
  );
  await page.goto(server.url);
  await expect(page.locator(".card iframe")).toBeVisible();
  await assetResponse;
});

test("a missing/evicted image shows a placeholder, not a broken image", async ({
  page,
  server,
}) => {
  const snip = await publish(server.url, { html: "<p>x</p>", title: "Doc", agent: "e2e" });
  await publishParts(server.url, {
    title: "Gone",
    session: snip.sessionId,
    parts: [{ kind: "image", assetId: "does-not-exist" }],
  });

  await page.goto(server.url);
  await expect(page.locator(".asset-gone")).toContainText("evicted");
});

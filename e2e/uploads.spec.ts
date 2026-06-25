import {
  expect,
  expectIframesNoHorizontalOverflow,
  expectNoHorizontalOverflow,
  publish,
  publishParts,
  test,
  TINY_PNG_B64,
  upload,
} from "./fixtures.ts";

test("an image surface renders an <img> served from /a/:id", async ({ page, server }) => {
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

test("a trace surface renders a step timeline with expandable detail", async ({ page, server }) => {
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
  const card = page.locator(".card:not(#whatsNew)");
  await expect(card.locator(".trace-title")).toHaveText("What I did");
  await expect(card.locator(".trace-step")).toHaveCount(2);
  await expect(card.locator(".trace-kind").first()).toHaveText("tool");

  // the step with a detail expands on click; the label-only one has no detail
  await expect(card.locator(".trace-detail")).toHaveCount(0);
  await card.locator(".trace-row.clickable").first().click();
  await expect(card.locator(".trace-detail")).toHaveText("opened the file at line 1");
});

test("a trace surface backed by an uploaded file offers a download and renders steps", async ({
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
  const card = page.locator(".card:not(#whatsNew)");
  await expect(card.locator(".trace-dl")).toHaveAttribute("href", `/a/${asset.id}`);
  // steps are fetched from the asset and rendered
  await expect(card.locator(".trace-step")).toHaveCount(2);
  await expect(card.locator(".trace-label").first()).toHaveText("step one");
});

test("a trace surface stays readable on an iPhone-sized viewport", async ({ page, server }) => {
  await publishParts(server.url, {
    title: "Trace on mobile",
    agent: "e2e",
    parts: [
      {
        kind: "trace",
        title: "Long trace heading that should truncate cleanly on mobile",
        steps: [
          {
            label:
              "ran a very long shell command with flags --workspace=/tmp/sideshow-mobile --include-traces --verify-sidebar",
            kind: "shell",
            ts: "2026-06-25T12:00:00Z",
            detail:
              "stdout: a-long-token-that-should-wrap-instead-of-forcing-horizontal-scroll ".repeat(
                6,
              ),
          },
          {
            label: "noted how the sidebar drawer and trace card read together on a phone",
            kind: "say",
            ts: "2026-06-25T12:00:03Z",
          },
        ],
      },
    ],
  });

  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto(server.url);

  const card = page.locator(".card:not(#whatsNew)");
  await expect(card.locator(".trace-title")).toBeVisible();
  await expect(card.locator(".trace-step")).toHaveCount(2);
  await card.locator(".trace-row.clickable").first().click();
  await expect(card.locator(".trace-detail")).toBeVisible();

  await expectNoHorizontalOverflow(page, "main");
  await expectNoHorizontalOverflow(page, ".card");
  await expectNoHorizontalOverflow(page, ".trace-surface");
});

test("all native surface primitives fit the iPhone 14 Pro viewer", async ({ page, server }) => {
  const asset = await upload(server.url, {
    data: TINY_PNG_B64,
    contentType: "image/png",
    filename: "mobile-primitive.png",
    kind: "image",
  });
  await publishParts(server.url, {
    title: "Every primitive on mobile",
    agent: "e2e",
    session: asset.sessionId,
    parts: [
      { kind: "html", html: "<section><h2>HTML</h2><p>Interactive surface shell.</p></section>" },
      { kind: "markdown", markdown: "## Markdown\n\n- readable prose\n- list item" },
      {
        kind: "diff",
        patch:
          "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old mobile spacing\n+new mobile spacing\n",
      },
      {
        kind: "terminal",
        text: "\u001b[32mPASS\u001b[0m mobile primitive check\n$ sideshow trace-sync --all",
        title: "terminal",
      },
      { kind: "image", assetId: asset.id, caption: "uploaded image primitive" },
      { kind: "mermaid", mermaid: "flowchart LR\n  A[Agent] --> B[sideshow]\n  B --> C[Phone]" },
      {
        kind: "json",
        data: {
          status: "ok",
          primitives: [
            "html",
            "markdown",
            "diff",
            "terminal",
            "image",
            "mermaid",
            "json",
            "code",
            "trace",
          ],
        },
      },
      {
        kind: "code",
        language: "ts",
        title: "mobile.ts",
        code: "export const mobilePrimitive = (kind: string) => `${kind}: ok`;\n",
      },
      {
        kind: "trace",
        title: "Trace primitive",
        steps: [
          {
            kind: "tool",
            label: "verified every native primitive on iPhone 14 Pro",
            detail: "html markdown diff terminal image mermaid json code trace",
          },
        ],
      },
    ],
  });

  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto(server.url);

  const card = page.locator(".card:not(#whatsNew)");
  await expect(card).toBeVisible();
  await expect(card.locator("iframe").first()).toBeVisible();
  await expectIframesNoHorizontalOverflow(page, card);
  await expect(card.locator(".asset-img")).toBeVisible();
  await expect(card.locator(".json-surface")).toContainText("primitives");
  await expect(card.locator(".trace-step")).toHaveCount(1);
  await card.locator(".trace-row.clickable").click();
  await expect(card.locator(".trace-detail")).toBeVisible();

  await expectNoHorizontalOverflow(page, "main");
  await expectNoHorizontalOverflow(page, ".card");
  await expectNoHorizontalOverflow(page, ".trace-surface");
});

test("an uploaded image embeds by URL inside an html surface under the CSP", async ({
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

import { type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { expect, publishParts, test, TINY_PNG_B64, upload } from "./fixtures.ts";

// Export tests open the response from disk instead of exercising only the HTTP
// preview. That is the user-visible portability boundary: the trusted shell and
// every srcdoc surface must still render when the top-level document is file://.
async function openSavedExport(page: Page, exportUrl: string, filePath: string): Promise<void> {
  const response = await fetch(exportUrl);
  expect(response.status).toBe(200);
  await writeFile(filePath, await response.text(), "utf8");
  await page.goto(pathToFileURL(filePath).href);
  await expect(page.locator(".ss-shell")).toBeVisible();
}

const MD = [
  "## Exported plan",
  "",
  "Prose that wraps across several lines so the rendered markdown is clearly",
  "taller than the 24px minimum frame height once the bridge measures it.",
  "",
  "- one",
  "- two",
  "- three",
].join("\n");

// A probe that tries to read the shell document across the sandbox boundary.
// The frame is sandboxed WITHOUT allow-same-origin, so `parent.document` throws
// a SecurityError — the frame is at an opaque origin. It self-reports into its
// own DOM (the only channel it has).
const PROBE = `<div id="r">running</div>
<script>
  try {
    var leaked = parent.document && parent.document.querySelector('.card');
    document.getElementById('r').textContent = leaked ? 'LEAKED' : 'blocked';
  } catch (e) {
    document.getElementById('r').textContent = 'blocked';
  }
</script>`;

test("a saved export lays out html and markdown while keeping frames isolated", async ({
  page,
  server,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const first = await publishParts(server.url, {
    title: "Probe card",
    agent: "e2e",
    parts: [{ kind: "html", html: PROBE }],
  });
  await publishParts(server.url, {
    title: "Markdown card",
    agent: "e2e",
    session: first.sessionId,
    parts: [{ kind: "markdown", markdown: MD }],
  });

  await openSavedExport(
    page,
    `${server.url}/api/sessions/${first.sessionId}/export`,
    testInfo.outputPath("html-markdown-export.html"),
  );

  // Two cards, chronological: the probe first, the markdown second.
  await expect(page.locator(".card")).toHaveCount(2);
  await expect(page.locator(".card h2")).toHaveText(["Probe card", "Markdown card"]);

  // Every embedded surface is sandboxed with no allow-same-origin.
  await expect(page.locator("iframe.ss-frame:not(.mdframe)")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  await expect(page.locator("iframe.mdframe")).toHaveAttribute("sandbox", "allow-scripts");

  const markdown = page.frameLocator("iframe.mdframe");
  await expect(markdown.locator("h2")).toHaveText("Exported plan");
  await expect(markdown.locator("li")).toHaveCount(3);

  // The markdown frame's bridge reports height, so it grows past the minimum.
  await expect
    .poll(async () => (await page.locator("iframe.mdframe").boundingBox())?.height ?? 0, {
      timeout: 10_000,
    })
    .toBeGreaterThan(60);

  // The html surface's script cannot reach the shell — opaque origin holds.
  const probe = page.frameLocator("iframe.ss-frame:not(.mdframe)").locator("#r");
  await expect(probe).toHaveText("blocked", { timeout: 10_000 });
  await expect(probe).not.toContainText("LEAKED");

  expect(consoleErrors.filter((error) => /content security policy|refused/i.test(error))).toEqual(
    [],
  );
});

test("a saved export renders diff, terminal, and code surfaces", async ({
  page,
  server,
}, testInfo) => {
  const published = await publishParts(server.url, {
    title: "Rich renderer export",
    agent: "e2e",
    parts: [
      {
        kind: "diff",
        files: [
          {
            filename: "greet.ts",
            before: "export const greet = () => 'hi';\n",
            after: "export const greet = (name: string) => `hi ${name}`;\n",
          },
        ],
      },
      {
        kind: "terminal",
        title: "export check",
        text: "\u001b[32mPASS\u001b[0m exported terminal\n<img src=x onerror=alert(1)>",
      },
      {
        kind: "code",
        title: "exported.ts",
        language: "ts",
        lineStart: 40,
        code: "export const exported = true;\nconsole.log(exported);",
      },
    ],
  });

  await openSavedExport(
    page,
    `${server.url}/api/sessions/${published.sessionId}/export?theme=gruvbox&mode=dark`,
    testInfo.outputPath("rich-surfaces-export.html"),
  );

  const frameSelectors = ["iframe.diffframe", "iframe.termframe", "iframe.codeframe"];
  for (const selector of frameSelectors) {
    await expect(page.locator(selector)).toHaveAttribute("sandbox", "allow-scripts");
  }

  const diff = page.frameLocator("iframe.diffframe");
  await expect(diff.locator("diffs-container")).toBeVisible();
  await expect(diff.locator("body")).toContainText("greet.ts");
  await expect(diff.locator("body")).toContainText("name");

  const terminal = page.frameLocator("iframe.termframe");
  await expect(terminal.locator(".term-title")).toHaveText("export check");
  await expect(terminal.locator(".term-body span[style*='color']")).toContainText("PASS");
  await expect(terminal.locator(".term-body")).toContainText("<img src=x onerror=alert(1)>");
  await expect(terminal.locator("img")).toHaveCount(0);

  const code = page.frameLocator("iframe.codeframe");
  await expect(code.locator(".code-filename")).toHaveText("exported.ts:40-41");
  await expect(code.locator(".code-lang")).toHaveText("ts");
  await expect(code.locator("pre.shiki, pre.plain")).toContainText("exported = true");
});

test("a saved export inlines image and JSON surfaces as inert data", async ({
  page,
  server,
}, testInfo) => {
  const asset = await upload(server.url, {
    data: TINY_PNG_B64,
    contentType: "image/png",
    filename: "export-pixel.png",
    kind: "image",
  });
  const published = await publishParts(server.url, {
    title: "Native data export",
    agent: "e2e",
    session: asset.sessionId,
    parts: [
      {
        kind: "image",
        assetId: asset.id,
        alt: "one transparent pixel",
        caption: "inlined image surface",
      },
      {
        kind: "json",
        data: { status: "exported", danger: "<script>window.leaked = true</script>" },
      },
      {
        kind: "trace",
        title: "Experimental trace",
        steps: [{ kind: "tool", label: "kept outside the product export" }],
      },
    ],
  });

  const commentResponse = await fetch(`${server.url}/api/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      surface: published.id,
      text: "Looks <safe> in the saved file",
      author: "user",
    }),
  });
  expect(commentResponse.status).toBe(201);

  await openSavedExport(
    page,
    `${server.url}/api/sessions/${published.sessionId}/export`,
    testInfo.outputPath("native-data-export.html"),
  );

  const image = page.locator(".ss-image img");
  await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(image).toHaveAttribute("alt", "one transparent pixel");
  await expect(page.locator(".ss-caption")).toHaveText("inlined image surface");
  await expect
    .poll(() => image.evaluate((element) => element.complete && element.naturalWidth))
    .toBe(1);

  const json = page.locator(".ss-json");
  await expect(json).toContainText('"status": "exported"');
  await expect(json).toContainText("<script>window.leaked = true</script>");
  await expect(json.locator("script")).toHaveCount(0);
  await expect(page.locator(".ss-thread")).toContainText("Looks <safe> in the saved file");
  await expect(page.locator(".ss-note")).toHaveText("Trace surface omitted from export.");
});

test("a saved export runs the Mermaid loader inside its sandbox", async ({
  page,
  server,
}, testInfo) => {
  const diagram = "flowchart LR\n  Agent[Agent] --> Export[Saved HTML]";
  await page.route("https://esm.sh/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body:
        "export default { initialize(){}, render(id, src){ " +
        "return Promise.resolve({ svg: '<svg xmlns=\"http://www.w3.org/2000/svg\"><text>' + src + '</text></svg>' }); } };",
    }),
  );
  const published = await publishParts(server.url, {
    title: "Mermaid export",
    agent: "e2e",
    parts: [{ kind: "mermaid", mermaid: diagram }],
  });

  await openSavedExport(
    page,
    `${server.url}/api/sessions/${published.sessionId}/export`,
    testInfo.outputPath("mermaid-export.html"),
  );

  await expect(page.locator("iframe.mermaidframe")).toHaveAttribute("sandbox", "allow-scripts");
  const mermaid = page.frameLocator("iframe.mermaidframe");
  await expect(mermaid.locator("svg")).toBeVisible();
  await expect(mermaid.locator("body")).toContainText("Agent");
  await expect(mermaid.locator("body")).toContainText("Saved HTML");
});

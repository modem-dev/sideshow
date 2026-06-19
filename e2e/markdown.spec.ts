import { expect, publishParts, test } from "./fixtures.ts";

const MD = [
  "## Plan",
  "",
  "Some prose with a [link](https://example.com).",
  "",
  "- first",
  "- second",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
  "",
  "Raw <script>alert(1)</script> must not execute.",
].join("\n");

test("a markdown part renders typed prose with a highlighted code block", async ({
  page,
  server,
}) => {
  await publishParts(server.url, {
    title: "Notes",
    agent: "e2e",
    parts: [{ kind: "markdown", markdown: MD }],
  });

  await page.goto(server.url);
  const card = page.locator(".card");

  // markdown renders inside an opaque-origin sandbox iframe (defense in depth:
  // even a markdown-it/shiki regression can't reach the board). The sandbox has
  // NO allow-same-origin — that's the isolation guarantee.
  await expect(card.locator("iframe.mdframe")).toHaveAttribute("sandbox", "allow-scripts");
  const md = card.frameLocator("iframe.mdframe");

  // structured typography inside the frame
  await expect(md.locator("h2")).toHaveText("Plan");
  await expect(md.locator("li")).toHaveCount(2);
  await expect(md.locator("a")).toHaveAttribute("target", "_blank");

  // the ```ts fence is upgraded to a shiki-highlighted block once the grammar
  // loads (async); a highlighted token carries an inline color style
  const code = md.locator("pre.shiki");
  await expect(code).toBeVisible();
  await expect(code.locator("span[style*='color']").first()).toBeVisible();

  // html:false — raw HTML in the source is escaped to text, never a live node
  await expect(md.locator("body")).toContainText("<script>alert(1)</script>");

  // the frame's own bridge reports content height, so it grows past the min
  await expect
    .poll(async () => (await card.locator("iframe.mdframe").boundingBox())?.height ?? 0, {
      timeout: 10_000,
    })
    .toBeGreaterThan(120);
});

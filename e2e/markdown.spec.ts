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
  const md = card.locator(".mdpart");

  // structured typography, not a sandboxed iframe
  await expect(md.locator("h2")).toHaveText("Plan");
  await expect(md.locator("li")).toHaveCount(2);
  // links open in a new tab (the markdown renders in the viewer document itself)
  await expect(md.locator("a")).toHaveAttribute("target", "_blank");

  // the ```ts fence is upgraded to a shiki-highlighted block once the grammar
  // loads (async); a highlighted token carries an inline color style
  const code = md.locator("pre.shiki");
  await expect(code).toBeVisible();
  await expect(code.locator("span[style*='color']").first()).toBeVisible();

  // html:false — raw HTML in the source is escaped, never a live <script>
  await expect(md.locator("script")).toHaveCount(0);
  await expect(md).toContainText("<script>alert(1)</script>");
});

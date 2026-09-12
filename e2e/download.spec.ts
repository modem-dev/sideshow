import { readFileSync } from "node:fs";
import { expect, publishParts, test } from "./fixtures.ts";

const DIAGRAM = "graph TD\n  A[Start] --> B[Done]";

// The share menu's download rows: one per surface, each saving the RAW SOURCE
// behind it rather than a rendering. The oracle is the saved file — its name and
// its bytes — because that is the whole promise: a diagram you can reopen and
// edit, not a picture of one.
test("a download row saves each surface as the file it came from", async ({ page, server }) => {
  await publishParts(server.url, {
    title: "Retry backoff",
    parts: [
      { kind: "mermaid", mermaid: DIAGRAM },
      { kind: "markdown", markdown: "the plan" },
    ],
    agent: "e2e",
  });

  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)").first();
  await card.locator("button.share").click();

  // One row per surface, labelled with the exact filename the save will use —
  // the numbering is what tells two surfaces of one post apart.
  const rows = page.locator(".share-menu .share-item", { hasText: "Download" });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText("Download retry-backoff.mmd");
  await expect(rows.nth(1)).toHaveText("Download retry-backoff-2.md");

  const [download] = await Promise.all([page.waitForEvent("download"), rows.nth(0).click()]);
  expect(download.suggestedFilename()).toBe("retry-backoff.mmd");
  const saved = await download.path();
  expect(readFileSync(saved, "utf8")).toBe(DIAGRAM);

  // Saving happens in place: the feed must still be there behind the menu.
  await expect(card).toBeVisible();
});

test("the row is named after the code surface's own filename", async ({ page, server }) => {
  await publishParts(server.url, {
    title: "Review",
    parts: [{ kind: "code", code: "export const a = 1;\n", language: "ts", title: "api.ts" }],
    agent: "e2e",
  });

  await page.goto(server.url);
  await page.locator(".card:not(#whatsNew)").first().locator("button.share").click();
  const row = page.locator(".share-menu .share-item", { hasText: "Download" });
  await expect(row).toHaveText("Download api.ts");

  const [download] = await Promise.all([page.waitForEvent("download"), row.click()]);
  expect(download.suggestedFilename()).toBe("api.ts");
  expect(readFileSync(await download.path(), "utf8")).toBe("export const a = 1;\n");
});

import { expect, publishParts, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { isSoftWrapSurfaceKind, SURFACE_FRAME_CLASSES, SURFACE_KINDS } from "../server/types.ts";

const SOFT_WRAP_KINDS = SURFACE_KINDS.filter(isSoftWrapSurfaceKind);

// Wide mode (issue #223): a workspace setting that lets the feed column grow past
// its 860px cap on a wide window, with markdown kept at a readable measure.
const LONG = `const value = compute(${"x".repeat(130)});`; // ~150 chars
const PARTS = [
  {
    kind: "markdown",
    markdown: `${"Some prose that should keep a readable measure. ".repeat(12)}\n\n\`\`\`text\n${LONG}\n\`\`\``,
  },
  { kind: "diff", patch: `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-${LONG}\n+${LONG}y` },
];

const streamWidth = (page: Page) =>
  page.locator("#stream").evaluate((el) => el.getBoundingClientRect().width);
// Rendered widths of the markdown prose paragraph and its code block.
const markdownWidths = (page: Page) =>
  page
    .frameLocator(".card:not(#whatsNew) iframe.mdframe")
    .locator("body")
    .evaluate(() => ({
      prose: document.querySelector("p")!.getBoundingClientRect().width,
      code: document.querySelector("pre")!.getBoundingClientRect().width,
    }));
// Widest sideways scroll inside a surface frame (@pierre/diffs renders in shadow roots).
const frameOverflow = (page: Page, frame: string) =>
  page
    .frameLocator(`.card:not(#whatsNew) iframe.${frame}`)
    .locator("body")
    .evaluate(() => {
      let max = 0;
      const walk = (root: Document | ShadowRoot) => {
        for (const el of root.querySelectorAll("*")) {
          if (/(auto|scroll)/.test(getComputedStyle(el).overflowX)) {
            max = Math.max(max, el.scrollWidth - el.clientWidth);
          }
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      return max;
    })
    // a width switch reloads the frame mid-poll; NaN fails both bounds, so poll again
    .catch(() => Number.NaN);
const diffOverflow = (page: Page) => frameOverflow(page, "diffframe");

test.use({ viewport: { width: 1930, height: 1000 } });

test("the wide toggle widens the column, persists, and toggles back to normal", async ({
  page,
  server,
}) => {
  await publishParts(server.url, { title: "Wide", agent: "e2e", parts: PARTS });
  await page.goto(server.url);
  const toggle = page.locator("#widthToggle");

  // normal (the default): the classic 860px column; the long diff line scrolls
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await streamWidth(page)).toBe(860);
  await expect.poll(() => diffOverflow(page)).toBeGreaterThan(1);
  const normalMarkdown = await markdownWidths(page);
  expect(normalMarkdown.prose).toBe(normalMarkdown.code);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => streamWidth(page)).toBe(1600);
  // the diff now fits; markdown prose keeps its readable measure while its code
  // block takes the full width
  await expect.poll(() => diffOverflow(page)).toBeLessThanOrEqual(1);
  await expect.poll(async () => (await markdownWidths(page)).code).toBeGreaterThan(1200);
  expect((await markdownWidths(page)).prose).toBeLessThanOrEqual(780);

  // PUT /api/width persisted it for the workspace
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => streamWidth(page)).toBe(1600);

  await toggle.click();
  await expect.poll(() => streamWidth(page)).toBe(860);
  await expect.poll(() => markdownWidths(page)).toEqual(normalMarkdown);
});

test("another open tab follows a width switch live", async ({ page, context, server }) => {
  await publishParts(server.url, { title: "Wide", agent: "e2e", parts: PARTS });
  const other = await context.newPage();
  await page.goto(server.url);
  await other.goto(server.url);
  await expect(other.locator(".card:not(#whatsNew)")).toBeVisible();
  expect(await streamWidth(other)).toBe(860);

  await page.locator("#widthToggle").click();
  await expect.poll(() => streamWidth(other)).toBe(1600);
});

test("phone layout is unchanged in wide mode and hides the toggle", async ({ page, server }) => {
  await publishParts(server.url, { title: "Wide", agent: "e2e", parts: PARTS });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.url);
  await expect(page.locator(".card:not(#whatsNew)")).toBeVisible();
  const normal = await streamWidth(page);

  const res = await page.request.put(`${server.url}/api/width`, { data: { id: "wide" } });
  expect(res.ok()).toBe(true);
  await page.reload();
  await expect(page.locator(".card:not(#whatsNew)")).toBeVisible();
  await expect(page.locator("#widthToggle")).toBeHidden();
  expect(await streamWidth(page)).toBe(normal);
});

test("wide mode soft-wraps lines longer than the column instead of scrolling", async ({
  page,
  server,
}) => {
  const huge = `${"word ".repeat(400)}end`; // ~2000 chars, wider than any column
  await publishParts(server.url, {
    title: "Wrap",
    agent: "e2e",
    parts: [
      { kind: "markdown", markdown: `\`\`\`text\n${huge}\n\`\`\`` },
      { kind: "code", code: `const s = "${huge}";`, language: "ts" },
      { kind: "terminal", text: huge },
      { kind: "diff", patch: `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-${huge}\n+${huge}!` },
    ],
  });
  await page.goto(server.url);
  const frames = SOFT_WRAP_KINDS.map((kind) => SURFACE_FRAME_CLASSES[kind]!);

  // normal: the long lines scroll sideways, as before
  for (const f of frames) await expect.poll(() => frameOverflow(page, f)).toBeGreaterThan(1);

  await page.locator("#widthToggle").click();
  await expect.poll(() => streamWidth(page)).toBe(1600);
  for (const f of frames) await expect.poll(() => frameOverflow(page, f)).toBeLessThanOrEqual(1);
});

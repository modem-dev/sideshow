import { expect, publishParts, test } from "./fixtures.ts";

// A surface with the two parts whose theming runs through different layers: an
// html part (re-themed by reloading its sandboxed iframe at /s/:id) and a
// markdown part (re-highlighted in-document by shiki). Together with the chrome
// palette that covers the layers CLAUDE.md warns must move as one.
const PARTS = [
  { kind: "html", html: "<p>surface body</p>" },
  { kind: "markdown", markdown: ["```ts", "const x: number = 1;", "```"].join("\n") },
];

// The first inline-colored token in the shiki block has its color baked in per
// theme, so it only changes if the markdown part actually re-highlighted.
test("switching the board theme re-themes chrome, html parts, and markdown together", async ({
  page,
  server,
}) => {
  await publishParts(server.url, { title: "Themed", agent: "e2e", parts: PARTS });

  await page.goto(server.url);
  const card = page.locator(".card");
  const iframe = card.locator("iframe");
  const token = card.locator(".mdpart pre.shiki span[style*='color']").first();

  // default theme is github; the iframe carries it in its src and the chrome
  // exposes the github light bg via the injected --bg var
  await expect(iframe).toHaveAttribute("src", /theme=github/);
  await expect(token).toBeVisible();
  const bgBefore = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
  );
  expect(bgBefore).toBe("#f6f8fa");
  const tokenBefore = await token.evaluate((el) => getComputedStyle(el).color);

  // switch to gruvbox via the chrome picker
  await page.locator("#themeSel").selectOption("gruvbox");

  // layer 1 — chrome palette: --bg becomes the gruvbox light bg
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      ),
    )
    .toBe("#f9f5d7");

  // layer 2 — html parts: the iframe src is re-keyed so the server re-injects
  // the matching tokens on reload
  await expect(iframe).toHaveAttribute("src", /theme=gruvbox/);

  // layer 3 — markdown: shiki re-highlights, so the baked-in token color shifts
  await expect.poll(() => token.evaluate((el) => getComputedStyle(el).color)).not.toBe(tokenBefore);
});

test("the picked theme persists across a reload", async ({ page, server }) => {
  await publishParts(server.url, { title: "Themed", agent: "e2e", parts: PARTS });

  await page.goto(server.url);
  await page.locator("#themeSel").selectOption("gruvbox");
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      ),
    )
    .toBe("#f9f5d7");

  // PUT /api/theme persisted the choice; a fresh load reads it back, no flash
  // of the default
  await page.reload();
  await expect(page.locator("#themeSel")).toHaveValue("gruvbox");
  await expect(page.locator(".card iframe")).toHaveAttribute("src", /theme=gruvbox/);
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      ),
    )
    .toBe("#f9f5d7");
});

test("a theme switch in one tab re-themes another open tab via SSE", async ({
  page,
  server,
  context,
}) => {
  await publishParts(server.url, { title: "Themed", agent: "e2e", parts: PARTS });

  await page.goto(server.url);
  const other = await context.newPage();
  await other.goto(server.url);
  await expect(other.locator(".card iframe")).toHaveAttribute("src", /theme=github/);

  // switch in the first tab; the second re-themes off the theme-changed SSE
  // event without its own user action
  await page.locator("#themeSel").selectOption("gruvbox");

  await expect(other.locator("#themeSel")).toHaveValue("gruvbox");
  await expect(other.locator(".card iframe")).toHaveAttribute("src", /theme=gruvbox/);
  await expect
    .poll(() =>
      other.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      ),
    )
    .toBe("#f9f5d7");
  await other.close();
});

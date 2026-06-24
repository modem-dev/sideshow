import { expect, publishParts, test } from "./fixtures.ts";

// A surface with the two parts whose theming runs through different layers: an
// html part (re-themed by reloading its sandboxed iframe at /s/:id?part=0) and a
// markdown part (server-rendered at /s/:id?part=1, iframe.mdframe — shiki
// re-highlights when the frame reloads with the new theme). Together with the
// chrome palette that covers the layers CLAUDE.md warns must move as one.
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
  // every part is now an iframe with a `src`, so target the html part by its
  // part index; the markdown part is iframe.mdframe and its shiki token is inside
  const iframe = card.locator('iframe[src*="part=0"]');
  const token = card
    .frameLocator("iframe.mdframe")
    .locator("pre.shiki span[style*='color']")
    .first();

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
  await expect(page.locator('.card iframe[src*="part=0"]')).toHaveAttribute("src", /theme=gruvbox/);
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      ),
    )
    .toBe("#f9f5d7");
});

// Regression: the chrome resolves light/dark from the OS via a CSS media query,
// but an html part is a separate iframe document whose own scheme resolution can
// diverge from the chrome's across the frame boundary — producing dark chrome
// with a white, light-inked iframe. The viewer now pins each frame to the mode
// it resolved (`&mode=` on the src + a forced `color-scheme`), so the iframe
// renders the SAME scheme as the chrome regardless. The github dark html-part
// surface (--color-background-primary) is #1c2128 = rgb(28, 33, 40).
test.describe("with the OS in dark mode", () => {
  test.use({ colorScheme: "dark" });

  test("the html-part iframe is pinned to dark, matching the chrome", async ({ page, server }) => {
    await publishParts(server.url, {
      title: "Themed",
      agent: "e2e",
      parts: [{ kind: "html", html: "<p>surface body</p>" }],
    });
    await page.goto(server.url);

    const iframe = page.locator(".card iframe[src]");
    await expect(iframe).toHaveAttribute("src", /mode=dark/);

    // the iframe document actually paints the dark surface — not the light
    // default it would fall back to if it re-derived the scheme on its own
    const body = page.locator(".card iframe[src]").contentFrame().locator("body");
    await expect
      .poll(() => body.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe("rgb(28, 33, 40)");
  });

  // The opaque html part forces `color-scheme` (so its UA scrollbars/controls
  // match), but a markdown part's frame is transparent so the themed card shows
  // through — forcing `color-scheme:dark` there would paint an opaque UA canvas
  // behind it. Its tokens are still pinned dark; only color-scheme stays unset.
  test("a transparent markdown frame is pinned dark but keeps no forced color-scheme", async ({
    page,
    server,
  }) => {
    await publishParts(server.url, {
      title: "Prose",
      agent: "e2e",
      parts: [{ kind: "markdown", markdown: "regular **prose** body" }],
    });
    await page.goto(server.url);

    const frame = page.locator(".card iframe.mdframe").contentFrame();
    // pinned dark: the chrome text var resolved to the github dark ink
    await expect
      .poll(() => frame.locator("body").evaluate((el) => getComputedStyle(el).color))
      .toBe("rgb(230, 237, 243)");
    // but the root color-scheme is NOT forced, so the UA canvas stays transparent
    await expect
      .poll(() => frame.locator("html").evaluate((el) => getComputedStyle(el).colorScheme))
      .not.toBe("dark");
  });
});

test.describe("with the OS in light mode", () => {
  test.use({ colorScheme: "light" });

  test("the html-part iframe is pinned to light", async ({ page, server }) => {
    await publishParts(server.url, {
      title: "Themed",
      agent: "e2e",
      parts: [{ kind: "html", html: "<p>surface body</p>" }],
    });
    await page.goto(server.url);

    const iframe = page.locator(".card iframe[src]");
    await expect(iframe).toHaveAttribute("src", /mode=light/);
    const body = page.locator(".card iframe[src]").contentFrame().locator("body");
    await expect
      .poll(() => body.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe("rgb(255, 255, 255)");
  });
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
  await expect(other.locator('.card iframe[src*="part=0"]')).toHaveAttribute("src", /theme=github/);

  // switch in the first tab; the second re-themes off the theme-changed SSE
  // event without its own user action
  await page.locator("#themeSel").selectOption("gruvbox");

  await expect(other.locator("#themeSel")).toHaveValue("gruvbox");
  await expect(other.locator('.card iframe[src*="part=0"]')).toHaveAttribute(
    "src",
    /theme=gruvbox/,
  );
  await expect
    .poll(() =>
      other.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      ),
    )
    .toBe("#f9f5d7");
  await other.close();
});

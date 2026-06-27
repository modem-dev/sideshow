import { expect, publish, test } from "./fixtures.ts";

test("clicking a session updates the URL to /session/:id", async ({ page, server }) => {
  const s1 = await publish(server.url, { html: "<p>one</p>", title: "First", agent: "a1" });
  const s2 = await publish(server.url, { html: "<p>two</p>", title: "Second", agent: "a2" });
  await page.goto(server.url);
  await expect(page.locator("#sessionList .sess")).toHaveCount(2);

  // Selecting a session pushes /session/:id. The topmost surface auto-focuses
  // internally, but the engine no longer pins it in the URL — only an explicit
  // surface open (a deep link, or scrolling into one) writes /session/:id/s/:id.
  await page.locator(`#sessionList .sess[data-id="${s2.sessionId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/session/${s2.sessionId}$`));

  // click the first session row
  await page.locator(`#sessionList .sess[data-id="${s1.sessionId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/session/${s1.sessionId}$`));
});

test("auto-selecting a session on boot does not pin the default surface in the URL", async ({
  page,
  server,
}) => {
  // A session with a post: landing at root auto-selects it. The topmost surface
  // auto-focuses internally, but the URL must stay /session/:id — no /s/:id —
  // because the user didn't open a specific surface.
  const s = await publish(server.url, { html: "<p>hi</p>", title: "Top", agent: "pi" });
  await page.goto(server.url);
  await expect(page.locator(`#sessionList .sess[data-id="${s.sessionId}"]`)).toHaveClass(/sel/);
  await expect(page).toHaveURL(new RegExp(`/session/${s.sessionId}$`));
});

test("navigating to /session/:id selects that session", async ({ page, server }) => {
  await publish(server.url, { html: "<p>one</p>", title: "First", agent: "a1" });
  const s2 = await publish(server.url, { html: "<p>two</p>", title: "Second", agent: "a2" });

  // go directly to the second session
  await page.goto(`${server.url}/session/${s2.sessionId}`);
  await expect(page.locator(`#sessionList .sess[data-id="${s2.sessionId}"]`)).toHaveClass(/sel/);
  await expect(page.locator(".card .card-title")).toHaveText("Second");
});

test("the browser title follows the selected session", async ({ page, server }) => {
  const s1 = await publish(server.url, {
    html: "<p>one</p>",
    title: "First post",
    agent: "a1",
    sessionTitle: "Auth refactor",
  });
  const s2 = await publish(server.url, {
    html: "<p>two</p>",
    title: "Second post",
    agent: "a2",
    sessionTitle: "Release prep",
  });

  await page.goto(`${server.url}/session/${s1.sessionId}`);
  await expect(page).toHaveTitle("Auth refactor · sideshow");

  await page.locator(`#sessionList .sess[data-id="${s2.sessionId}"]`).click();
  await expect(page).toHaveTitle("Release prep · sideshow");
});

test("the standalone share page title uses the shared post title", async ({ page, server }) => {
  const post = await publish(server.url, {
    html: "<p>one</p>",
    title: "First post",
    agent: "a1",
    sessionTitle: "Auth refactor",
  });
  const sessionListRequests: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (req.method() === "GET" && url.pathname === "/api/sessions") {
      sessionListRequests.push(req.url());
    }
  });

  await page.goto(`${server.url}/s/${post.id}`);
  await expect(page).toHaveTitle("First post");

  await publish(server.url, { html: "<p>two</p>", title: "Other work", agent: "a2" });
  await expect.poll(() => sessionListRequests.length).toBeGreaterThan(0);
  await expect(page).toHaveTitle("First post");
});

test("navigating to /session/:id/s/:surfaceId selects session and scrolls to surface", async ({
  page,
  server,
}) => {
  // Publish enough tall surfaces so the target is off-screen initially.
  const s1 = await publish(server.url, {
    html: '<div style="height:800px"><h2>Top</h2></div>',
    title: "A",
    agent: "pi",
  });
  await publish(server.url, {
    html: '<div style="height:800px"><h2>Middle</h2></div>',
    title: "B",
    agent: "pi",
    session: s1.sessionId,
  });
  const s3 = await publish(server.url, {
    html: '<div style="height:800px"><h2>Bottom</h2></div>',
    title: "C",
    agent: "pi",
    session: s1.sessionId,
  });

  // Deep link to the last surface
  await page.goto(`${server.url}/session/${s1.sessionId}/s/${s3.id}`);
  await expect(page.locator(`#sessionList .sess[data-id="${s1.sessionId}"]`)).toHaveClass(/sel/);
  // All surfaces should be loaded (full session view)
  await expect(page.locator(".card:not(#whatsNew) .card-title")).toHaveCount(3);
  // The target surface should be scrolled near the top of the viewport.
  // pollScrollIntoView retries every 50 ms until the position stabilises (≤ 5 s).
  await expect
    .poll(
      async () => {
        return page.locator(`.card[data-id="${s3.id}"]`).evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= -10 && r.top <= 200;
        });
      },
      { timeout: 6000 },
    )
    .toBe(true);
  // URL should include the surface id
  await expect(page).toHaveURL(new RegExp(`/session/${s1.sessionId}/s/${s3.id}`));
});

test("browser back/forward navigates between sessions", async ({ page, server }) => {
  const s1 = await publish(server.url, { html: "<p>one</p>", title: "First", agent: "a1" });
  const s2 = await publish(server.url, { html: "<p>two</p>", title: "Second", agent: "a2" });
  await page.goto(server.url);
  await expect(page.locator("#sessionList .sess")).toHaveCount(2);

  await page.locator(`#sessionList .sess[data-id="${s1.sessionId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/session/${s1.sessionId}(\\b|/)`));

  await page.locator(`#sessionList .sess[data-id="${s2.sessionId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/session/${s2.sessionId}(\\b|/)`));

  // go back — should return to first session
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/session/${s1.sessionId}(\\b|/)`));
  await expect(page.locator(`#sessionList .sess[data-id="${s1.sessionId}"]`)).toHaveClass(/sel/);

  // go forward — should return to second session
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/session/${s2.sessionId}(\\b|/)`));
  await expect(page.locator(`#sessionList .sess[data-id="${s2.sessionId}"]`)).toHaveClass(/sel/);
});

test("clicking the sidebar wordmark returns home and clears the selection", async ({
  page,
  server,
}) => {
  const s1 = await publish(server.url, { html: "<p>one</p>", title: "First", agent: "a1" });
  await page.goto(server.url);
  await page.locator(`#sessionList .sess[data-id="${s1.sessionId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/session/${s1.sessionId}(\\b|/)`));
  await expect(page.locator(`#sessionList .sess[data-id="${s1.sessionId}"]`)).toHaveClass(/sel/);

  // The wordmark is a home button: it drops the selection and routes back to the
  // session-less base path — the guaranteed way back to the board when no session
  // row is available to click (e.g. a host's full-page view over an empty board).
  await page.locator("aside .brand").click();
  await expect(page).not.toHaveURL(/\/session\//);
  await expect(page.locator(`#sessionList .sess[data-id="${s1.sessionId}"]`)).not.toHaveClass(
    /sel/,
  );
});

test("/ redirects to the last viewed session from localStorage", async ({ page, server }) => {
  const s = await publish(server.url, { html: "<p>hi</p>", title: "Sticky", agent: "pi" });

  // visit the session to populate localStorage
  await page.goto(`${server.url}/session/${s.sessionId}`);
  await expect(page.locator(`#sessionList .sess[data-id="${s.sessionId}"]`)).toHaveClass(/sel/);

  // now visit root — should redirect to the last session
  await page.goto(server.url);
  await expect(page).toHaveURL(new RegExp(`/session/${s.sessionId}$`));
  await expect(page.locator(`#sessionList .sess[data-id="${s.sessionId}"]`)).toHaveClass(/sel/);
});

test("scrolling through surfaces updates the URL", async ({ page, server }) => {
  // publish enough surfaces to force scrolling
  const s1 = await publish(server.url, {
    html: '<div style="height:800px"><h2>Top</h2></div>',
    title: "Surface A",
    agent: "pi",
  });
  await publish(server.url, {
    html: '<div style="height:800px"><h2>Middle</h2></div>',
    title: "Surface B",
    agent: "pi",
    session: s1.sessionId,
  });
  const s3 = await publish(server.url, {
    html: '<div style="height:800px"><h2>Bottom</h2></div>',
    title: "Surface C",
    agent: "pi",
    session: s1.sessionId,
  });

  await page.goto(`${server.url}/session/${s1.sessionId}`);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(3);

  // scroll the last surface into view
  await page.locator(`.card[data-id="${s3.id}"]`).scrollIntoViewIfNeeded();
  await expect(page).toHaveURL(new RegExp(`/session/${s1.sessionId}/s/${s3.id}$`));

  // scroll back to the first surface
  await page.locator(`.card[data-id="${s1.id}"]`).scrollIntoViewIfNeeded();
  await expect(page).toHaveURL(new RegExp(`/session/${s1.sessionId}/s/${s1.id}$`));
});

test("/s/:id bare surface route shows the standalone full-page surface", async ({
  page,
  server,
}) => {
  const s = await publish(server.url, { html: "<h2>Standalone</h2>", title: "Solo" });
  await page.goto(`${server.url}/s/${s.id}`);

  // A bare direct link is the full-page standalone view: just that one surface,
  // no sidebar / session feed / comments, with a sideshow watermark beneath.
  await expect(page.locator("#standalone")).toHaveCount(1);
  await expect(page.locator("#sessionList")).toHaveCount(0);
  await expect(page.locator("#standalone .card[data-id]")).toHaveCount(1);
  await expect(page.locator(`.card[data-id="${s.id}"] .card-title`)).toHaveText("Solo");
  // No comment thread chrome in standalone mode.
  await expect(page.locator(".card .thread")).toHaveCount(0);
  await expect(page.locator(".standalone-foot a")).toHaveAttribute("href", "https://sideshow.sh");

  // It stays on the canonical share URL — it does not rewrite into a
  // session-scoped deep link the way the in-feed deep link does.
  await expect(page).toHaveURL(new RegExp(`/s/${s.id}$`));

  // The authored HTML is still rendered only inside the sandboxed part iframe.
  await expect(page.frameLocator(`.card[data-id="${s.id}"] iframe`).locator("h2")).toHaveText(
    "Standalone",
  );
});

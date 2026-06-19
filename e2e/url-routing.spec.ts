import { expect, publish, test } from "./fixtures.ts";

test("clicking a session updates the URL to /session/:id", async ({ page, server }) => {
  const s1 = await publish(server.url, { html: "<p>one</p>", title: "First", agent: "a1" });
  const s2 = await publish(server.url, { html: "<p>two</p>", title: "Second", agent: "a2" });
  await page.goto(server.url);
  await expect(page.locator("#sessionList .sess")).toHaveCount(2);

  // click the second session row
  await page.locator(`#sessionList .sess[data-id="${s2.sessionId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/session/${s2.sessionId}$`));

  // click the first session row
  await page.locator(`#sessionList .sess[data-id="${s1.sessionId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/session/${s1.sessionId}$`));
});

test("navigating to /session/:id selects that session", async ({ page, server }) => {
  await publish(server.url, { html: "<p>one</p>", title: "First", agent: "a1" });
  const s2 = await publish(server.url, { html: "<p>two</p>", title: "Second", agent: "a2" });

  // go directly to the second session
  await page.goto(`${server.url}/session/${s2.sessionId}`);
  await expect(page.locator(`#sessionList .sess[data-id="${s2.sessionId}"]`)).toHaveClass(/sel/);
  await expect(page.locator(".card .card-title")).toHaveText("Second");
});

test("navigating to /session/:id/s/:surfaceId selects the session", async ({ page, server }) => {
  const s1 = await publish(server.url, { html: "<p>first</p>", title: "A", agent: "pi" });
  const s2 = await publish(server.url, {
    html: "<p>second</p>",
    title: "B",
    agent: "pi",
    session: s1.sessionId,
  });

  // deep link with a surface id selects the session
  await page.goto(`${server.url}/session/${s1.sessionId}/s/${s2.id}`);
  await expect(page.locator(`#sessionList .sess[data-id="${s1.sessionId}"]`)).toHaveClass(/sel/);
  // both surfaces should be loaded (full session view)
  await expect(page.locator(".card:not(#whatsNew) .card-title")).toHaveCount(2);
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

test("/s/:id standalone surface route still works unchanged", async ({ page, server }) => {
  const s = await publish(server.url, { html: "<h2>Standalone</h2>", title: "Solo" });
  await page.goto(`${server.url}/s/${s.id}`);
  // standalone route renders the raw surface, not the viewer SPA
  await expect(page.locator("h2")).toHaveText("Standalone");
  // the sidebar should NOT be present
  await expect(page.locator("#sessionList")).toHaveCount(0);
});

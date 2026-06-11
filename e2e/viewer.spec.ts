import { expect, publish, test, update } from "./fixtures.ts";

test("snippet published over HTTP appears live via SSE, no reload", async ({ page, server }) => {
  await page.goto(server.url);
  await expect(page.locator("#onboard")).toBeVisible();

  await publish(server.url, { html: "<h2>It works</h2>", title: "Live test", agent: "e2e" });

  // the card streams in over SSE — the page is never reloaded
  await expect(page.locator(".card:not(#sessionThread) .card-title")).toHaveText("Live test");
  await expect(page.locator("#onboard")).toBeHidden();
  await expect(page.locator(".sess-title")).toContainText("e2e session");
});

test("resize bridge grows the iframe beyond its 120px default", async ({ page, server }) => {
  const tall = `<div style="height: 600px">tall content</div>`;
  await publish(server.url, { html: tall, title: "Tall", agent: "e2e" });

  await page.goto(server.url);
  const iframe = page.locator(".card iframe");
  await expect(iframe).toBeVisible();
  // the sandboxed bridge must report content height via postMessage; this is
  // the WebKit-quirk regression test (see CLAUDE.md)
  await expect
    .poll(async () => (await iframe.boundingBox())?.height ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(300);
});

test("comment typed in the composer round-trips to the API", async ({ page, server }) => {
  const snippet = await publish(server.url, { html: "<p>v1</p>", title: "Doc", agent: "e2e" });

  await page.goto(server.url);
  const card = page.locator(".card:not(#sessionThread)");
  const input = card.locator(".composer input");
  await input.fill("ship it");
  await input.press("Enter");

  // renders in the thread (via SSE) and is persisted server-side
  await expect(card.locator(".cmt .txt")).toHaveText("ship it");
  await expect(card.locator(".cmt .who")).toHaveText("you");
  await expect
    .poll(async () => {
      const res = await fetch(`${server.url}/api/comments?snippet=${snippet.id}`);
      const data = (await res.json()) as { comments: { text: string }[] };
      return data.comments.map((c) => c.text);
    })
    .toContain("ship it");
});

test("session thread shows snippet-less comments and messages the agent", async ({
  page,
  server,
}) => {
  const snippet = await publish(server.url, { html: "<p>x</p>", title: "Doc", agent: "e2e" });

  await page.goto(server.url);
  const thread = page.locator("#sessionThread");
  await expect(thread).toBeVisible();

  // an agent comment with no snippet attached (sideshow comment without --snippet)
  await fetch(`${server.url}/api/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: snippet.sessionId, text: "agent note", author: "e2e" }),
  });
  await expect(thread.locator(".cmt .txt")).toHaveText("agent note");

  // the user can reply without picking a snippet; it lands as a user comment
  const input = thread.locator(".composer input");
  await input.fill("user note");
  await input.press("Enter");
  await expect(thread.locator(".cmt .txt")).toHaveText(["agent note", "user note"]);
  await expect
    .poll(async () => {
      const res = await fetch(
        `${server.url}/api/comments?session=${snippet.sessionId}&author=user`,
      );
      const data = (await res.json()) as { comments: { snippetId: string | null; text: string }[] };
      return data.comments.filter((c) => !c.snippetId).map((c) => c.text);
    })
    .toContain("user note");

  // snippets published later still appear above the session thread
  await publish(server.url, { html: "<p>y</p>", title: "Later", session: snippet.sessionId });
  await expect(page.locator("#stream > .card").last()).toHaveId("sessionThread");
  await expect(page.locator("#stream > .card")).toHaveCount(3);
});

test("a failed comment send restores the input instead of losing the message", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>x</p>", title: "Doc", agent: "e2e" });

  await page.goto(server.url);
  const card = page.locator(".card:not(#sessionThread)");
  await page.route("**/api/comments", (route) =>
    route.request().method() === "POST" ? route.abort() : route.fallback(),
  );

  const input = card.locator(".composer input");
  await input.fill("important feedback");
  await input.press("Enter");

  await expect(page.locator("#toast")).toContainText("Couldn't send");
  await expect(input).toHaveValue("important feedback");
  await expect(card.locator(".cmt")).toHaveCount(0);

  // and once the network is back, the same send goes through
  await page.unroute("**/api/comments");
  await input.press("Enter");
  await expect(card.locator(".cmt .txt")).toHaveText("important feedback");
});

test("a comment echoes immediately, before the SSE round-trip confirms it", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>x</p>", title: "Doc", agent: "e2e" });

  await page.goto(server.url);
  const card = page.locator(".card:not(#sessionThread)");
  // hold the POST open so only the optimistic echo can render
  await page.route("**/api/comments", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  const input = card.locator(".composer input");
  await input.fill("instant echo");
  await input.press("Enter");

  const cmt = card.locator(".cmt");
  await expect(cmt).toHaveClass(/pending/);
  await expect(cmt.locator(".txt")).toHaveText("instant echo");
  // settles into a confirmed comment, still exactly one copy
  await expect(cmt).not.toHaveClass(/pending/, { timeout: 10_000 });
  await expect(card.locator(".cmt")).toHaveCount(1);
});

test("a snippet published while scrolled up shows a pill instead of yanking", async ({
  page,
  server,
}) => {
  const first = await publish(server.url, {
    html: '<div style="height: 1400px">tall content</div>',
    title: "Tall",
    agent: "e2e",
  });

  await page.goto(server.url);
  const main = page.locator("main");
  // wait for the bridge to grow the iframe so the stream actually overflows
  await expect
    .poll(() => main.evaluate((m) => m.scrollHeight - m.clientHeight), { timeout: 15_000 })
    .toBeGreaterThan(400);
  await main.evaluate((m) => (m.scrollTop = 0));

  await publish(server.url, { html: "<p>new</p>", title: "Later", session: first.sessionId });

  await expect(page.locator("#newPill")).toBeVisible();
  expect(await main.evaluate((m) => m.scrollTop)).toBe(0); // reading position kept

  await page.locator("#newPill").click();
  await expect(page.locator("#newPill")).toBeHidden();
  await expect.poll(() => main.evaluate((m) => m.scrollTop)).toBeGreaterThan(200);
});

test("activity in an unselected session badges the tab title until viewed", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>a</p>", title: "First", agent: "one" });

  await page.goto(server.url);
  await expect(page).toHaveTitle("sideshow");

  await publish(server.url, { html: "<p>b</p>", title: "Second", agent: "two" });

  await expect(page).toHaveTitle("(1) sideshow");
  await page.locator(".sess", { hasText: "two" }).click();
  await expect(page).toHaveTitle("sideshow");
});

test("at phone width the sidebar collapses into a drawer and actions stay visible", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>m</p>", title: "Mobile", agent: "e2e" });

  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(server.url);

  // the sidebar is off-canvas and the stream gets the full width
  const card = page.locator(".card:not(#sessionThread)");
  await expect(card).toBeVisible();
  await expect(page.locator("aside")).not.toBeInViewport();
  expect((await card.boundingBox())!.width).toBeGreaterThan(300);

  // hover-only card actions are always visible at narrow widths
  await expect(card.locator(".act.open")).toHaveCSS("opacity", "1");

  // the menu button opens the drawer; picking a session closes it again
  await page.locator("#menuBtn").click();
  await expect(page.locator("aside")).toBeInViewport();
  await page.locator(".sess").click();
  await expect(page.locator("aside")).not.toBeInViewport();
});

test("version select appears live after an update", async ({ page, server }) => {
  const snippet = await publish(server.url, { html: "<p>v1</p>", title: "Doc", agent: "e2e" });

  await page.goto(server.url);
  await expect(page.locator(".card .vbadge")).toHaveText("v1");

  await update(server.url, snippet.id, { html: "<p>v2</p>" });

  const select = page.locator("select.vbadge");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("2");
  await expect(select.locator("option")).toHaveText(["v2", "v1"]);
});

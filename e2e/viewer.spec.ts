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

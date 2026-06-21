import { expect, publicReadTest as test, publish } from "./fixtures.ts";

async function postComment(
  serverUrl: string,
  token: string,
  body: { surface: string; text: string },
) {
  const res = await fetch(`${serverUrl}/api/comments`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, author: "user" }),
  });
  if (!res.ok) throw new Error(`comment failed: ${res.status}`);
}

test("public read viewer globals are visible to the browser", async ({
  page,
  publicReadServer,
}) => {
  await page.goto(publicReadServer.url);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as Window & {
          __SIDESHOW_READONLY__?: boolean;
          __SIDESHOW_PUBLIC_READ__?: "session" | "full";
        };
        return { readonly: w.__SIDESHOW_READONLY__, mode: w.__SIDESHOW_PUBLIC_READ__ };
      }),
    )
    .toEqual({ readonly: true, mode: publicReadServer.mode });
});

test("readonly full-mode chrome hides sidebar write controls", async ({
  page,
  publicReadServer,
}) => {
  await publish(
    publicReadServer.url,
    { html: "<p>controls</p>", title: "Readonly chrome", agent: "e2e" },
    publicReadServer.token,
  );

  await page.goto(publicReadServer.url);

  await expect(page.locator("#sessionList .sess .x")).toHaveCount(0);
  await expect(page.locator(".theme-picker")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "connect Claude Code" })).toHaveCount(0);
  await expect(page.locator("#sessTitle")).toHaveAttribute("contenteditable", "false");
});

test("readonly empty board shows a simple empty state", async ({ page, publicReadServer }) => {
  await page.goto(publicReadServer.url);

  await expect(page.locator("#onboard")).toBeVisible();
  await expect(page.locator("#onboard h1")).toHaveText("Nothing here yet");
  await expect(page.locator("#onboard .snip")).toHaveCount(0);
  await expect(page.locator("#onboard .connect-btn")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "design guide" })).toBeVisible();
  await expect(page.getByRole("link", { name: "agent setup" })).toBeVisible();
});

test("readonly iframe send-prompt bridge messages do not write comments", async ({
  page,
  publicReadServer,
}) => {
  await publish(
    publicReadServer.url,
    {
      html: `<script>parent.postMessage({__sideshow:true,type:"send-prompt",text:"please write"},"*")</script>`,
      title: "Prompt bridge",
      agent: "e2e",
    },
    publicReadServer.token,
  );
  let commentPosts = 0;
  await page.route("**/api/comments", async (route) => {
    if (route.request().method() === "POST") commentPosts += 1;
    await route.continue();
  });

  await page.goto(publicReadServer.url);
  await expect(page.locator(".card:not(#whatsNew) iframe")).toBeVisible();
  await page.waitForTimeout(500);

  expect(commentPosts).toBe(0);
  await expect(page.locator("#toast")).not.toHaveClass(/show/);
});

test("readonly cards hide comment and delete controls but keep read actions", async ({
  page,
  publicReadServer,
}) => {
  const surface = await publish(
    publicReadServer.url,
    { html: "<p>readable</p>", title: "Readonly card", agent: "e2e" },
    publicReadServer.token,
  );
  await postComment(publicReadServer.url, publicReadServer.token, {
    surface: surface.id,
    text: "existing feedback",
  });

  await page.goto(publicReadServer.url);

  const card = page.locator(".card:not(#whatsNew)");
  await expect(card.locator(".act.comment")).toHaveCount(0);
  await expect(card.locator(".act.del")).toHaveCount(0);
  await expect(card.locator(".act.copy")).toBeVisible();
  await expect(card.locator(".act.open")).toBeVisible();
  await expect(card.frameLocator(".cmtframe").locator("body")).toContainText("existing feedback");
  await expect(card.locator(".composer")).toHaveCount(0);
});

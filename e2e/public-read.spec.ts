import { expect, publicReadTest as test, publish, startSideshowServer } from "./fixtures.ts";

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

test("readonly session-mode viewer loads without fetching the session list", async ({ page }) => {
  const token = "secret";
  const server = await startSideshowServer({
    SIDESHOW_TOKEN: token,
    SIDESHOW_PUBLIC_READ: "session",
  });
  try {
    const surface = await publish(
      server.url,
      {
        html: "<p>session scoped</p>",
        title: "Session scoped",
        agent: "e2e",
        sessionTitle: "Auth refactor",
      },
      token,
    );
    const sessionListRequests: string[] = [];
    const eventUrls: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (req.method() === "GET" && url.pathname === "/api/sessions") {
        sessionListRequests.push(req.url());
      }
      if (url.pathname === "/api/events") eventUrls.push(req.url());
    });

    await page.goto(`${server.url}/session/${surface.sessionId}`);

    await expect(page).toHaveTitle("Auth refactor · sideshow");
    await expect(page.locator(".card:not(#whatsNew)")).toBeVisible();
    await expect(page.locator(".card-title")).toContainText("Session scoped");
    expect(sessionListRequests).toEqual([]);
    await expect
      .poll(() =>
        eventUrls.some((url) => new URL(url).searchParams.get("session") === surface.sessionId),
      )
      .toBe(true);
  } finally {
    server.stop();
  }
});

test("readonly session-mode viewer receives live surfaces without refreshing the list", async ({
  page,
}) => {
  const token = "secret";
  const server = await startSideshowServer({
    SIDESHOW_TOKEN: token,
    SIDESHOW_PUBLIC_READ: "session",
  });
  try {
    const first = await publish(
      server.url,
      { html: "<p>first</p>", title: "First live card", agent: "e2e" },
      token,
    );
    const sessionListRequests: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (req.method() === "GET" && url.pathname === "/api/sessions") {
        sessionListRequests.push(req.url());
      }
    });

    await page.goto(`${server.url}/session/${first.sessionId}`);

    await expect(page.locator(".card-title")).toContainText("First live card");
    await expect(page.locator(".topbar .livedot")).toHaveClass(/on/);

    await publish(
      server.url,
      { html: "<p>second</p>", title: "Second live card", agent: "e2e", session: first.sessionId },
      token,
    );

    await expect(page.locator(".card-title", { hasText: "Second live card" })).toBeVisible();
    expect(sessionListRequests).toEqual([]);
  } finally {
    server.stop();
  }
});

test("readonly session-mode viewer renders without sidebar chrome", async ({ page }) => {
  const token = "secret";
  const server = await startSideshowServer({
    SIDESHOW_TOKEN: token,
    SIDESHOW_PUBLIC_READ: "session",
  });
  try {
    const surface = await publish(
      server.url,
      { html: "<p>single session</p>", title: "Single session", agent: "e2e" },
      token,
    );

    await page.goto(`${server.url}/session/${surface.sessionId}`);

    await expect(page.locator("aside")).toHaveCount(0);
    await expect(page.locator("button.menu")).toHaveCount(0);
    await expect(page.locator("#scrim")).toHaveCount(0);
    await expect(page.locator("#onboard")).toHaveCount(0);
    await expect(page.locator(".topbar .brand")).toContainText("sideshow");
    await expect(page.locator(".card:not(#whatsNew)")).toBeVisible();
  } finally {
    server.stop();
  }
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
  await expect(page.getByRole("link", { name: "connect agent" })).toHaveCount(0);
  await expect(page.locator("#sessTitle")).toHaveAttribute("contenteditable", "false");
});

test("readonly empty board shows a simple empty state", async ({ page, publicReadServer }) => {
  await page.goto(publicReadServer.url);

  await expect(page.locator("#onboard")).toBeVisible();
  await expect(page.locator("#onboard h1")).toHaveText("Nothing here yet");
  await expect(page.locator("#onboard .snip")).toHaveCount(0);
  await expect(page.locator("#onboard .connect-block")).toHaveCount(0);
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
  await expect(card.locator(".cmt-text")).toContainText("existing feedback");
  await expect(card.locator(".composer")).toHaveCount(0);
});

import {
  expect,
  expectNoHorizontalOverflow,
  publish,
  publishParts,
  test,
  update,
} from "./fixtures.ts";

test("the sidebar groups sessions by recency and sinks empty ones to the bottom", async ({
  page,
  server,
}) => {
  // one session with a surface, one with none (created directly)
  await publish(server.url, { html: "<p>x</p>", title: "Has work", agent: "busy" });
  await fetch(`${server.url}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "idle", title: "Empty one" }),
  });

  await page.goto(server.url);

  // both were created just now, so they share one recency group
  await expect(page.locator(".sess-group").first()).toHaveText("Today");

  // the empty session is marked vacant and sinks below the one with work
  const rows = page.locator("#sessionList .sess");
  await expect(rows).toHaveCount(2);
  // the session with work is on top even though the empty one is more recent;
  // its count rides the title as "(1)"
  await expect(rows.nth(0).locator(".sess-count")).toHaveText("(1)");
  await expect(rows.nth(0)).not.toHaveClass(/vacant/);
  // the empty session sinks below, marked vacant, with no count on its title
  await expect(rows.nth(1)).toHaveClass(/vacant/);
  await expect(rows.nth(1)).toContainText("Empty one");
  await expect(rows.nth(1).locator(".sess-count")).toHaveCount(0);
});

test("session rows show the agent's logo, with a fallback for unknown agents", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>x</p>", title: "A", agent: "claude" });
  await publish(server.url, { html: "<p>y</p>", title: "B", agent: "some-new-agent" });

  await page.goto(server.url);

  // every row carries an inline agent mark in its meta — a known brand glyph
  // or the neutral fallback for an unrecognized agent
  const rows = page.locator("#sessionList .sess");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator(".sess-meta svg.agent-mark")).toBeVisible();
  await expect(rows.nth(1).locator(".sess-meta svg.agent-mark")).toBeVisible();
});

test("snippet published over HTTP appears live via SSE, no reload", async ({ page, server }) => {
  await page.goto(server.url);
  await expect(page.locator("#onboard")).toBeVisible();

  await publish(server.url, { html: "<h2>It works</h2>", title: "Live test", agent: "e2e" });

  // the card streams in over SSE — the page is never reloaded
  await expect(page.locator(".card .card-title")).toHaveText("Live test");
  await expect(page.locator("#onboard")).toBeHidden();
  await expect(page.locator(".sess-title")).toContainText("e2e session");
});

test("a burst of live post changes shares one session-list refresh", async ({ page, server }) => {
  const first = await publish(server.url, {
    html: "<p>first</p>",
    title: "First",
    agent: "e2e",
    sessionTitle: "Burst",
  });
  const existing = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      publish(server.url, {
        html: `<p>${i}</p>`,
        title: `Existing ${i}`,
        agent: "e2e",
        session: first.sessionId,
      }),
    ),
  );
  await page.goto(`${server.url}/session/${first.sessionId}`);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(5);
  await expect(page.locator(".livedot").first()).toHaveClass(/on/);

  let sessionListRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/sessions") sessionListRequests++;
  });

  const deletes = existing.slice(2).map(async ({ id }) => {
    const response = await fetch(`${server.url}/api/snippets/${id}`, { method: "DELETE" });
    expect(response.ok).toBe(true);
  });
  await Promise.all([
    ...Array.from({ length: 3 }, (_, i) =>
      publish(server.url, {
        html: `<p>new ${i}</p>`,
        title: `New ${i}`,
        agent: "e2e",
        session: first.sessionId,
      }),
    ),
    update(server.url, existing[0].id, { title: "Updated 0" }),
    update(server.url, existing[1].id, { title: "Updated 1" }),
    ...deletes,
  ]);

  // Every create/update/delete still reconciles its card, while the sidebar
  // metadata refresh waits for the burst's quiet edge and runs once.
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(6);
  await expect(page.locator(".card-title", { hasText: "Updated 0" })).toHaveCount(1);
  await expect(page.locator(".card-title", { hasText: "Updated 1" })).toHaveCount(1);
  await expect(page.locator(".card-title", { hasText: /^New / })).toHaveCount(3);
  await expect.poll(() => sessionListRequests).toBe(1);
  await page.waitForTimeout(200);
  expect(sessionListRequests).toBe(1);
  await expect(page.locator(".sess-count")).toHaveText("(6)");

  // Hold a stale coalesced response in flight. A second post event must queue a
  // trailing refresh, while an overlapping session lifecycle refresh must win
  // even when the older response is released afterward.
  sessionListRequests = 0;
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  let routedSessionRequests = 0;
  let captureFirstResponse!: () => void;
  let releaseFirstResponse!: () => void;
  let captureTrailingResponse!: () => void;
  let releaseTrailingResponse!: () => void;
  let captureFailedResponse!: () => void;
  let releaseFailedResponse!: () => void;
  let captureOlderSuccess!: () => void;
  let releaseOlderSuccess!: () => void;
  let captureNewerFailure!: () => void;
  const firstResponseCaptured = new Promise<void>((resolve) => (captureFirstResponse = resolve));
  const firstResponseRelease = new Promise<void>((resolve) => (releaseFirstResponse = resolve));
  const trailingResponseCaptured = new Promise<void>(
    (resolve) => (captureTrailingResponse = resolve),
  );
  const trailingResponseRelease = new Promise<void>(
    (resolve) => (releaseTrailingResponse = resolve),
  );
  const failedResponseCaptured = new Promise<void>((resolve) => (captureFailedResponse = resolve));
  const failedResponseRelease = new Promise<void>((resolve) => (releaseFailedResponse = resolve));
  const olderSuccessCaptured = new Promise<void>((resolve) => (captureOlderSuccess = resolve));
  const olderSuccessRelease = new Promise<void>((resolve) => (releaseOlderSuccess = resolve));
  const newerFailureCaptured = new Promise<void>((resolve) => (captureNewerFailure = resolve));

  await page.route("**/api/sessions", async (route) => {
    routedSessionRequests++;
    if (routedSessionRequests === 1) {
      const response = await route.fetch();
      captureFirstResponse();
      await firstResponseRelease;
      await route.fulfill({ response });
      return;
    }
    if (routedSessionRequests === 3) {
      const response = await route.fetch();
      captureTrailingResponse();
      await trailingResponseRelease;
      await route.fulfill({ response });
      return;
    }
    if (routedSessionRequests === 4) {
      captureFailedResponse();
      await failedResponseRelease;
      await route.abort("failed");
      return;
    }
    if (routedSessionRequests === 6) {
      const response = await route.fetch();
      captureOlderSuccess();
      await olderSuccessRelease;
      await route.fulfill({ response });
      return;
    }
    if (routedSessionRequests === 7) {
      captureNewerFailure();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await publish(server.url, {
    html: "<p>during first refresh</p>",
    title: "During first refresh",
    agent: "e2e",
    session: first.sessionId,
  });
  await firstResponseCaptured;

  await publish(server.url, {
    html: "<p>while first refresh is in flight</p>",
    title: "While refresh is in flight",
    agent: "e2e",
    session: first.sessionId,
  });
  const rename = await fetch(`${server.url}/api/sessions/${first.sessionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Burst renamed" }),
  });
  expect(rename.ok).toBe(true);

  // The immediate session-updated refresh is request two and carries the latest
  // title/count while request one still holds the older snapshot.
  await expect.poll(() => routedSessionRequests).toBe(2);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(8);
  await expect(page.locator("#sessionList .sess-title")).toContainText("Burst renamed");
  await expect(page.locator(".sess-count")).toHaveText("(8)");

  releaseFirstResponse();
  await trailingResponseCaptured;

  // Request one has now completed, but the already-applied newer successful
  // response keeps its stale seven-post snapshot from rolling the sidebar back.
  await expect(page.locator("#sessionList .sess-title")).toContainText("Burst renamed");
  await expect(page.locator(".sess-count")).toHaveText("(8)");

  releaseTrailingResponse();
  await expect.poll(() => sessionListRequests).toBe(3);
  await expect(page.locator(".sess-count")).toHaveText("(8)");

  // A failed in-flight refresh must not swallow an event queued behind it. The
  // newer event drives request five and repairs the sidebar without waiting for
  // the periodic poll.
  await publish(server.url, {
    html: "<p>request will fail</p>",
    title: "Request will fail",
    agent: "e2e",
    session: first.sessionId,
  });
  await failedResponseCaptured;
  await publish(server.url, {
    html: "<p>queues recovery</p>",
    title: "Queues recovery",
    agent: "e2e",
    session: first.sessionId,
  });
  // Publishing and SSE use separate connections. Seeing the card proves the
  // second event incremented the feed version before we reject request four.
  await expect(page.locator(".card-title", { hasText: "Queues recovery" })).toHaveCount(1);
  releaseFailedResponse();

  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(10);
  await expect.poll(() => sessionListRequests).toBe(5);
  await expect(page.locator(".sess-count")).toHaveText("(10)");

  // A newer failed request must not invalidate an older successful response.
  // Otherwise bootstrap can discard its only valid session list and remain on
  // the empty-workspace view with no periodic poll available to repair it.
  await publish(server.url, {
    html: "<p>older success</p>",
    title: "Older success",
    agent: "e2e",
    session: first.sessionId,
  });
  await olderSuccessCaptured;
  const failedRename = await fetch(`${server.url}/api/sessions/${first.sessionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Refresh will fail" }),
  });
  expect(failedRename.ok).toBe(true);
  await newerFailureCaptured;
  releaseOlderSuccess();

  await expect.poll(() => sessionListRequests).toBe(7);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(11);
  await expect(page.locator(".sess-count")).toHaveText("(11)");
  expect(pageErrors).toEqual([]);
});

test("continuous live activity cannot starve the session-list refresh", async ({
  page,
  server,
}) => {
  const selectedSession = await publish(server.url, {
    html: "<p>selected</p>",
    title: "Selected",
    agent: "e2e",
    sessionTitle: "Selected session",
  });
  const targetResponse = await fetch(`${server.url}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "stream", title: "Background stream" }),
  });
  expect(targetResponse.ok).toBe(true);
  const targetSession = (await targetResponse.json()) as { id: string };

  await page.goto(`${server.url}/session/${selectedSession.sessionId}`);
  await expect(page.locator("#sessionList .sess")).toHaveCount(2);
  await expect(page.locator(".livedot").first()).toHaveClass(/on/);

  let sessionListRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/sessions") sessionListRequests++;
  });

  let completedPublishes = 0;
  const writes = Array.from({ length: 40 }, (_, i) =>
    new Promise<void>((resolve) => setTimeout(resolve, i * 20)).then(async () => {
      await publish(server.url, {
        html: `<p>${i}</p>`,
        title: `Stream ${i}`,
        agent: "stream",
        session: targetSession.id,
      });
      completedPublishes++;
    }),
  );

  // Events continue for roughly 800 ms, well beyond the 250 ms maximum wait.
  // The sidebar must refresh while the stream is still active instead of
  // waiting for a 50 ms quiet edge that may never arrive.
  await expect.poll(() => sessionListRequests, { timeout: 600 }).toBeGreaterThan(0);
  expect(completedPublishes).toBeLessThan(40);

  await Promise.all(writes);
  const targetRow = page.locator("#sessionList .sess", { hasText: "Background stream" });
  await expect(targetRow.locator(".sess-count")).toHaveText("(40)");
});

test("a surface kind this viewer doesn't know shows a refresh hint, not a broken diff", async ({
  page,
  server,
}) => {
  // Simulate a long-open tab that predates a newly shipped surface type: the
  // server returns a valid surface, but rewrite the surface kind to one THIS
  // viewer build has no Match for. It must degrade to a neutral hint, never
  // the diff fallback.
  await page.route(
    /\/api\/(posts\/[^/?]+(?:\/viewer)?|sessions\/[^/]+\/posts)(\?|$)/,
    async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const rewrite = (post: any) => {
        if (Array.isArray(post.surfaces)) {
          post.surfaces = post.surfaces.map(() => ({ kind: "futurething" }));
        }
        return post;
      };
      await route.fulfill({
        response: res,
        json: Array.isArray(body) ? body.map(rewrite) : rewrite(body),
      });
    },
  );

  await page.goto(server.url);
  // wait until the page is loaded and its SSE is connected, so the publish
  // below reliably streams in (mirrors the other live-update tests)
  await expect(page.locator("#onboard")).toBeVisible();
  await publish(server.url, { html: "<p>x</p>", title: "Future part", agent: "e2e" });

  const card = page.locator(".card:not(#whatsNew)").first();
  await expect(card.locator(".surface-unsupported")).toBeVisible();
  await expect(card.locator(".diff-error")).toHaveCount(0);
});

test("opening a session shows a skeleton while posts load", async ({ page, server }) => {
  const first = await publish(server.url, {
    html: "<p>slow</p>",
    title: "Slow load",
    agent: "e2e",
  });

  await page.route(`**/api/sessions/${first.sessionId}/posts**`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto(server.url);

  await expect(page.getByRole("status", { name: "Loading posts" })).toBeVisible();
  await expect(page.locator(".sk-card")).toHaveCount(3);
  await expect(page.locator(".card:not(#whatsNew) .card-title")).toHaveText("Slow load");
  await expect(page.getByRole("status", { name: "Loading posts" })).toHaveCount(0);
});

test("opening a session hydrates posts without N+1 post detail fetches", async ({
  page,
  server,
}) => {
  const first = await publish(server.url, {
    html: "<p>one</p>",
    title: "One",
    agent: "e2e",
    sessionTitle: "Hydrate",
  });
  await publish(server.url, {
    html: "<p>two</p>",
    title: "Two",
    agent: "e2e",
    session: first.sessionId,
  });
  await publish(server.url, {
    html: "<p>three</p>",
    title: "Three",
    agent: "e2e",
    session: first.sessionId,
  });

  const postDetailRequests: string[] = [];
  const hydratedListRequests: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "GET") return;
    const url = new URL(req.url());
    if (/^\/api\/posts\/[^/]+$/.test(url.pathname)) postDetailRequests.push(req.url());
    if (url.pathname === `/api/sessions/${first.sessionId}/posts`) {
      hydratedListRequests.push(url.searchParams.get("hydrate") ?? "");
    }
  });

  await page.goto(`${server.url}/session/${first.sessionId}`);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(3);
  expect(hydratedListRequests).toContain("1");
  expect(postDetailRequests).toEqual([]);
});

test("resize bridge grows the iframe beyond its 120px default", async ({ page, server }) => {
  const tall = `<div style="height: 600px">tall content</div>`;
  await publish(server.url, { html: tall, title: "Tall", agent: "e2e" });

  await page.goto(server.url);
  const iframe = page.locator(".card iframe");
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute("loading", "lazy");
  // the sandboxed bridge must report content height via postMessage; this is
  // the WebKit-quirk regression test (see CLAUDE.md)
  await expect
    .poll(async () => (await iframe.boundingBox())?.height ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(300);
});

test("comment typed in the composer round-trips to the API", async ({ page, server }) => {
  const snippet = await publish(server.url, { html: "<p>v1</p>", title: "Doc", agent: "e2e" });

  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)");
  await card.locator(".act.comment").click();
  const input = card.locator(".composer input");
  await input.fill("ship it");
  await input.press("Enter");

  // renders in the thread (via SSE) and is persisted server-side. The comment
  // text renders as an escaped Solid text node (plain data — no iframe).
  await expect(card.locator(".cmt-text")).toContainText("ship it");
  await expect(card.locator(".cmt .who")).toHaveText("you");
  await expect
    .poll(async () => {
      const res = await fetch(`${server.url}/api/comments?snippet=${snippet.id}`);
      const data = (await res.json()) as { comments: { text: string }[] };
      return data.comments.map((c) => c.text);
    })
    .toContain("ship it");
});

test("a comment's copy button puts an agent-ready paste block on the clipboard", async ({
  page,
  server,
  context,
  browserName,
}) => {
  const snippet = await publish(server.url, { html: "<p>x</p>", title: "Doc", agent: "e2e" });
  // only chromium lets tests grant clipboard access; the other engines still
  // exercise the button + toast path
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }

  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)");
  await card.locator(".act.comment").click();
  const input = card.locator(".composer input");
  await input.fill("tighten the spacing");
  await input.press("Enter");

  // the copy button appears only once the comment is confirmed (not pending)
  const cmt = card.locator(".cmt");
  await expect(cmt).not.toHaveClass(/pending/);
  await cmt.hover();
  await cmt.locator(".copy").click();

  await expect(page.locator("#toast")).toContainText("Copied");
  if (browserName === "chromium") {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `sideshow comment on “Doc” (post ${snippet.id}):\n“tighten the spacing”`,
    );
  }
});

test("a failed comment send restores the input instead of losing the message", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>x</p>", title: "Doc", agent: "e2e" });

  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)");
  await page.route("**/api/comments", (route) =>
    route.request().method() === "POST" ? route.abort() : route.fallback(),
  );

  await card.locator(".act.comment").click();
  const input = card.locator(".composer input");
  await input.fill("important feedback");
  await input.press("Enter");

  await expect(page.locator("#toast")).toContainText("Couldn't post");
  await expect(input).toHaveValue("important feedback");
  await expect(card.locator(".cmt")).toHaveCount(0);

  // and once the network is back, the same send goes through
  await page.unroute("**/api/comments");
  await input.press("Enter");
  await expect(card.locator(".cmt-text")).toContainText("important feedback");
});

test("a comment echoes immediately, before the SSE round-trip confirms it", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>x</p>", title: "Doc", agent: "e2e" });

  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)");
  // hold the POST open so only the optimistic echo can render
  await page.route("**/api/comments", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  await card.locator(".act.comment").click();
  const input = card.locator(".composer input");
  await input.fill("instant echo");
  await input.press("Enter");

  const cmt = card.locator(".cmt");
  await expect(cmt).toHaveClass(/pending/);
  await expect(cmt.locator(".cmt-text")).toContainText("instant echo");
  // settles into a confirmed comment, still exactly one copy
  await expect(cmt).not.toHaveClass(/pending/, { timeout: 10_000 });
  await expect(card.locator(".cmt")).toHaveCount(1);
});

test("a comment containing raw HTML is sandboxed and escaped, never a live node", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>x</p>", title: "Doc", agent: "e2e" });

  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)");
  await card.locator(".act.comment").click();
  const input = card.locator(".composer input");
  await input.fill("<img src=x onerror=alert(1)> hi");
  await input.press("Enter");

  // the comment renders as a Solid text node — the raw HTML is escaped to text,
  // never a live <img> (escapes by construction; no iframe needed for plain data)
  const text = card.locator(".cmt-text");
  await expect(text).toContainText("<img src=x onerror=alert(1)> hi");
  await expect(text.locator("img")).toHaveCount(0);
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
  await expect(page).toHaveTitle("one session · sideshow");

  await publish(server.url, { html: "<p>b</p>", title: "Second", agent: "two" });

  await expect(page).toHaveTitle("(1) one session · sideshow");
  await page.locator(".sess", { hasText: "two" }).click();
  await expect(page).toHaveTitle("two session · sideshow");
});

test("Cmd+Option+Up/Down switches between sessions, wrapping at the ends", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>a</p>", title: "First", agent: "one" });
  await publish(server.url, { html: "<p>b</p>", title: "Second", agent: "two" });

  await page.goto(server.url);
  // the newest session sits at the top of the list and is selected on load
  await expect(page.locator(".sess.sel .sess-title")).toContainText("two session");

  // Down moves to the next (older) session down the list
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(page.locator(".sess.sel .sess-title")).toContainText("one session");

  // Down again wraps back to the top
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(page.locator(".sess.sel .sess-title")).toContainText("two session");

  // Up wraps from the top back to the bottom
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await expect(page.locator(".sess.sel .sess-title")).toContainText("one session");
});

test("the desktop sidebar can collapse to a minimal rail and expand again", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>x</p>", title: "Compact", agent: "e2e" });
  await page.setViewportSize({ width: 701, height: 800 });
  await page.goto(server.url);

  const aside = page.locator("aside");
  const main = page.locator("main");
  const toggle = page.getByRole("button", { name: "Collapse sidebar" });
  const expandedMainWidth = (await main.boundingBox())!.width;

  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();

  const expand = page.getByRole("button", { name: "Expand sidebar" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(aside).toHaveCSS("width", "40px");
  await expect(page.locator("#sessionList")).toBeHidden();
  expect((await main.boundingBox())!.width).toBeGreaterThan(expandedMainWidth + 150);

  await expand.click();
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  await expect(aside).toHaveCSS("width", "248px");
  await expect(page.locator("#sessionList")).toBeVisible();

  // One pixel narrower hands control back to the existing mobile drawer.
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeHidden();
  await expect(aside).not.toBeInViewport();
});

test("at phone width the sidebar collapses into a drawer and actions stay visible", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>m</p>", title: "Mobile", agent: "e2e" });
  const longSession = (await (
    await fetch(`${server.url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "e2e",
        title: "A deliberately long mobile sidebar session title that should not shove controls",
      }),
    })
  ).json()) as { id: string };
  await publish(server.url, {
    html: "<p>long session row</p>",
    title: "Long title mobile",
    agent: "e2e",
    session: longSession.id,
  });

  await fetch(`${server.url}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "idle", title: "Empty session still shown in drawer" }),
  });

  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto(`${server.url}/session/${longSession.id}`);

  // the sidebar is off-canvas and the stream gets the full width
  const card = page.locator(".card:not(#whatsNew)");
  await expect(card).toBeVisible();
  await expect(page.locator("aside")).not.toBeInViewport();
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeHidden();
  expect((await card.boundingBox())!.width).toBeGreaterThan(300);

  // hover-only card actions are always visible at narrow widths
  await expect(card.locator(".act.open")).toHaveCSS("opacity", "1");

  // the menu button opens the drawer; picking a session closes it again
  await page.locator("#menuBtn").click();
  await expect(page.locator("aside")).toBeInViewport();
  await expectNoHorizontalOverflow(page, "main");
  await expectNoHorizontalOverflow(page, "aside");
  const longSessionTitle = page.getByText("A deliberately long mobile sidebar", { exact: false });
  const longSessionRow = page.locator('[role="button"]').filter({ has: longSessionTitle });
  await expect(longSessionRow).toBeVisible();
  const deleteLongSession = longSessionRow.getByRole("button", { name: /^Delete session/ });
  await expect(deleteLongSession).toBeVisible();
  await deleteLongSession.click({ trial: true });
  await longSessionRow.click();
  await expect(page.locator("aside")).not.toBeInViewport();
});

test("timeline traces wrap cleanly at iPhone 14 Pro width", async ({ page, server }) => {
  const surface = await publishParts(server.url, {
    title: "Timeline anchor",
    agent: "e2e",
    parts: [
      { kind: "markdown", markdown: "## Timeline card\n\nThe trace wraps around this card." },
    ],
  });
  await fetch(`${server.url}/api/sessions/${surface.sessionId}/trace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      steps: [
        {
          kind: "prompt",
          label: "prompt-" + "unbrokenprompttoken".repeat(8),
          detail:
            "A longer prompt detail that should expand without creating horizontal document scroll.",
        },
        {
          kind: "say",
          label: "response-" + "unbrokenresponsetoken".repeat(8),
        },
        {
          kind: "shell",
          label:
            "npm run trace-check -- --device=iPhone14Pro --case=long-command-label-without-spaces",
          detail:
            "command output: " +
            "unbroken-token-for-overflow-regression-".repeat(8) +
            "\nsecond line with normal words",
        },
        { kind: "say", label: "The timeline remains readable on a phone." },
      ],
      reset: true,
    }),
  });

  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto(`${server.url}/session/${surface.sessionId}`);
  await page.locator(".view-toggle button", { hasText: "Timeline" }).click();

  await expect(page.locator(".timeline")).toBeVisible();
  await expect(page.getByText("prompt-unbrokenprompttoken", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Show 1 work step" }).click();
  await expect(page.getByRole("button", { name: "Hide 1 work step" })).toBeVisible();
  await page.getByText("npm run trace-check", { exact: false }).click();
  await expect(
    page.getByText("unbroken-token-for-overflow-regression", { exact: false }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "main");
  await expectNoHorizontalOverflow(page, ".timeline");
});

test("the Connect an agent page shows the add-mcp logo picker", async ({ page, server }) => {
  await page.goto(server.url);

  await page.getByRole("link", { name: "connect agent" }).click();
  await expect(page).toHaveURL(`${server.url}/connect`);
  await expect(page.getByRole("heading", { name: "Connect an agent" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Connect an agent" })).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "Choose how to connect" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Most agents" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator(".connect-page")).toContainText(`npx add-mcp ${server.url}/mcp`);

  await page.getByRole("radio", { name: "Other" }).click();
  await expect(page.locator(".connect-page")).toContainText('"mcpServers"');
  await expect(page.locator(".connect-page")).toContainText(`${server.url}/mcp`);
});

test("the Connect an agent page is reachable directly when sessions already exist", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: "<p>connected</p>", title: "Existing", agent: "e2e" });

  await page.goto(`${server.url}/connect`);

  await expect(page).toHaveURL(`${server.url}/connect`);
  await expect(page.getByRole("heading", { name: "Connect an agent" })).toBeVisible();
  await expect(page.locator(".connect-page")).toContainText(`npx add-mcp ${server.url}/mcp`);
});

test("live creates and updates fetch compact viewer posts with retained versions", async ({
  page,
  server,
}) => {
  const first = await publish(server.url, {
    html: "<p>existing</p>",
    title: "Existing",
    agent: "e2e",
  });
  const compactRequests: string[] = [];
  const fullDetailRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const path = new URL(request.url()).pathname;
    if (/^\/api\/posts\/[^/]+\/viewer$/.test(path)) compactRequests.push(path);
    if (/^\/api\/posts\/[^/]+$/.test(path)) fullDetailRequests.push(path);
  });

  await page.goto(`${server.url}/session/${first.sessionId}`);
  await expect(page.locator(".card .vbadge")).toHaveText("v1");

  const live = await publish(server.url, {
    html: "<p>v1</p>",
    title: "Live compact",
    agent: "e2e",
    session: first.sessionId,
  });
  const liveCard = page.locator(`.card[data-id="${live.id}"]`);
  await expect(liveCard.locator(".card-title")).toHaveText("Live compact");

  await update(server.url, live.id, { html: "<p>v2</p>", title: "Live compact v2" });

  await expect(liveCard.locator(".card-title")).toHaveText("Live compact v2");
  const select = liveCard.locator("select.vbadge");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("2");
  await expect(select.locator("option")).toHaveText(["v2", "v1"]);
  await expect.poll(() => compactRequests.filter((path) => path.includes(live.id)).length).toBe(2);
  expect(fullDetailRequests).toEqual([]);
});

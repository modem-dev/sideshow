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

test("a surface kind this viewer doesn't know shows a refresh hint, not a broken diff", async ({
  page,
  server,
}) => {
  // Simulate a long-open tab that predates a newly shipped surface type: the
  // server returns a valid surface, but rewrite the surface kind to one THIS
  // viewer build has no Match for. It must degrade to a neutral hint, never
  // the diff fallback.
  await page.route(/\/api\/surfaces\/[^/?]+(\?|$)/, async (route) => {
    const res = await route.fetch();
    const surface = await res.json();
    if (Array.isArray(surface.surfaces)) {
      surface.surfaces = surface.surfaces.map(() => ({ kind: "futurething" }));
    }
    await route.fulfill({ response: res, json: surface });
  });

  await page.goto(server.url);
  // wait until the page is loaded and its SSE is connected, so the publish
  // below reliably streams in (mirrors the other live-update tests)
  await expect(page.locator("#onboard")).toBeVisible();
  await publish(server.url, { html: "<p>x</p>", title: "Future part", agent: "e2e" });

  const card = page.locator(".card:not(#whatsNew)").first();
  await expect(card.locator(".surface-unsupported")).toBeVisible();
  await expect(card.locator(".diff-error")).toHaveCount(0);
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
  await expect(page).toHaveTitle("sideshow");

  await publish(server.url, { html: "<p>b</p>", title: "Second", agent: "two" });

  await expect(page).toHaveTitle("(1) sideshow");
  await page.locator(".sess", { hasText: "two" }).click();
  await expect(page).toHaveTitle("sideshow");
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

test("the Connect Claude Code modal shows the plugin install commands", async ({
  page,
  server,
}) => {
  await page.goto(server.url);

  await page.getByRole("link", { name: "connect Claude Code" }).click();
  const modal = page.getByRole("dialog", { name: "Connect Claude Code" });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("/plugin marketplace add modem-dev/sideshow");
  await expect(modal).toContainText("/plugin install sideshow@sideshow");
  await expect(modal).toContainText("sideshow watch");

  // Escape dismisses it
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
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

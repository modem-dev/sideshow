import { expect, publish, test } from "./fixtures.ts";

// The sandbox attribute (asserted across the part specs) is the *shape* of the
// isolation; this spec asserts the *behavior* the project's core invariant
// promises: script that runs inside an html part cannot reach the board API,
// because the CSP connect-src omits the server origin. A regression that put the
// board origin back into connect-src (or dropped the CSP meta tag) would keep
// the sandbox attribute intact and pass every other test while silently opening
// exfil — this is the test that catches it, on real Chromium and WebKit.
//
// The probe can't phone home (that's the point), so it self-reports the outcome
// into its own DOM; Playwright reads that across the opaque origin.
const PROBE = `<div id="r">running</div>
<script>
  // Relative URL resolves against the frame's document (the board origin), so
  // this targets the authenticated API. connect-src must refuse it.
  fetch('/api/surfaces')
    .then(function (res) { document.getElementById('r').textContent = 'LEAKED status ' + res.status; })
    .catch(function () { document.getElementById('r').textContent = 'blocked'; });
</script>`;

test("an html part's script is CSP-blocked from fetching the board API", async ({
  page,
  server,
}) => {
  await publish(server.url, { html: PROBE, title: "probe", agent: "e2e" });

  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)").first();
  const probe = card.frameLocator("iframe").locator("#r");

  // the fetch is refused before it leaves the frame -> the catch runs
  await expect(probe).toHaveText("blocked", { timeout: 10_000 });
  // and it must never have succeeded
  await expect(probe).not.toContainText("LEAKED");
});

// sendPrompt is the bridge channel a surface uses to put text into its thread.
// A surface script can fire it — or post the raw bridge message — with no user
// interaction, so it must never be able to mint an author:"user" comment: that
// label is reserved for the viewer's composer (genuine keystrokes), and the
// feedback loop only delivers "user" comments to the agent. The fix stamps
// surface sends author:"surface". These tests pin that against a surface that
// auto-fires on load and would, before the fix, have impersonated the user.
const AUTO_SEND = `<script>parent.postMessage({__sideshow:true,type:"send-prompt",text:"injected by surface"},"*")</script>`;

test("an auto-fired send-prompt is labeled surface, never user", async ({ page, server }) => {
  const { id } = await publish(server.url, { html: AUTO_SEND, title: "auto-send", agent: "e2e" });

  let posted: Record<string, unknown> | null = null;
  await page.route("**/api/comments", async (route) => {
    if (route.request().method() === "POST") posted = route.request().postDataJSON();
    await route.continue();
  });

  await page.goto(server.url);
  await expect(page.locator(".card:not(#whatsNew) iframe")).toBeVisible();
  await expect(page.locator("#toast")).toHaveClass(/show/, { timeout: 5_000 });

  expect(posted).toMatchObject({ surface: id, text: "injected by surface", author: "surface" });
  expect((posted as { author?: string }).author).not.toBe("user");
});

test("a surface send is not delivered to the agent as user feedback", async ({
  page,
  server,
  request,
}) => {
  const { id, sessionId } = await publish(server.url, {
    html: AUTO_SEND,
    title: "auto-send",
    agent: "e2e",
  });

  await page.goto(server.url);
  await expect(page.locator(".card:not(#whatsNew) iframe")).toBeVisible();
  await expect(page.locator("#toast")).toHaveClass(/show/, { timeout: 5_000 });

  // The surface comment exists on the thread (unfiltered read sees it)...
  const all = await (await request.get(`${server.url}/api/comments?surface=${id}`)).json();
  expect(all.comments.some((c: { author: string }) => c.author === "surface")).toBe(true);

  // ...but the agent's feedback channel (author=user) never surfaces it.
  const feedback = await (
    await request.get(`${server.url}/api/comments?session=${sessionId}&author=user`)
  ).json();
  expect(feedback.comments).toHaveLength(0);
});

import { expect, publish, test } from "./fixtures.ts";
import { renderSandboxedPart } from "../server/surfacePage.ts";

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

// openLink reaches the host's window.open. The in-frame click handler forwards
// only http(s) hrefs, but a surface can post the raw bridge message with any
// scheme, so the host must re-validate. These pin both edges against a surface
// that auto-fires the raw message on load — the bypass an attacker would use.
const openLinkMsg = (url: string) =>
  `<script>parent.postMessage({__sideshow:true,type:"open-link",url:${JSON.stringify(url)}},"*")</script>`;

test("openLink ignores non-http(s) and malformed urls — no prompt, no open", async ({
  page,
  server,
}) => {
  // A scheme that parses (javascript:), another (data:), and a string that
  // fails to parse at all — all must be refused before the confirm.
  const bad = ["javascript:alert(1)", "data:text/html,<b>x</b>", "::: not a url :::"];
  const fire = `<script>${bad
    .map(
      (u) => `parent.postMessage({__sideshow:true,type:"open-link",url:${JSON.stringify(u)}},"*");`,
    )
    .join("")}</script>`;
  await publish(server.url, { html: fire, title: "bad", agent: "e2e" });

  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });

  await page.goto(server.url);
  await expect(page.locator(".card:not(#whatsNew) iframe").first()).toBeVisible();
  await page.waitForTimeout(500);

  // Each is rejected before the confirm, so no dialog is ever raised.
  expect(dialogs).toBe(0);
});

test("openLink still prompts for an http(s) url", async ({ page, server }) => {
  await publish(server.url, {
    html: openLinkMsg("https://example.com/"),
    title: "good",
    agent: "e2e",
  });

  let dialogMsg = "";
  page.on("dialog", (d) => {
    dialogMsg = d.message();
    void d.dismiss(); // dismiss so nothing actually navigates
  });

  await page.goto(server.url);
  await expect(page.locator(".card:not(#whatsNew) iframe").first()).toBeVisible();
  await page.waitForTimeout(500);

  expect(dialogMsg).toContain("https://example.com/");
});

// The viewer embeds /s/:id in a sandboxed iframe, but the document is served
// from the board origin — so a TOP-LEVEL load (open-in-new-tab, a shared link)
// must not run the agent's script in the board origin. The `sandbox` CSP
// response header forces an opaque origin however the doc is loaded; this proves
// the browser actually applies it, not just that the header is present.
test("a top-level surface document loads in an opaque (sandboxed) origin", async ({
  page,
  server,
}) => {
  const { id } = await publish(server.url, {
    html: `<p id="probe">hi</p>`,
    title: "top-level",
    agent: "e2e",
  });

  await page.goto(`${server.url}/s/${id}?part=0`);
  await expect(page.locator("#probe")).toHaveText("hi"); // it did render + run scripts

  // ...but in an opaque origin: window.origin is "null", so this document can't
  // read the board's cookies/storage or reach a same-origin viewer window.
  const origin = await page.evaluate(() => window.origin);
  expect(origin).toBe("null");
});

// Rich parts now load via a blob: URL instead of srcdoc (to dodge a Chrome 149
// field trial that breaks opaque-origin srcdoc layout). The rich-part CSP
// deliberately allows 'unsafe-inline' so the bridge runs without a nonce — which
// means the OPAQUE ORIGIN is the only thing containing a script. So the security
// question for the blob: switch is exactly: does a blob-loaded rich frame still
// get an opaque origin? This injects a body as if a markdown-it / mermaid /
// diff sanitizer bypass let raw <script> through, lets it RUN, and proves it is
// still walled off from the board — can't read its origin, can't write the
// parent. (Same probe-self-reports-into-its-own-DOM trick as the html test: the
// frame can't phone home, so Playwright reads the verdict across the boundary.)
test("a rich part loaded via blob: URL is opaque-origin — a script that runs can't reach the board", async ({
  page,
  server,
}) => {
  const evil = `<div id="r">running</div>
<script>
  var out = String(window.origin);
  try {
    parent.document.body.dataset.pwned = '1'; // same-origin would succeed here
    out += ' | REACHED-PARENT';
  } catch (e) {
    out += ' | parent-blocked';
  }
  document.getElementById('r').textContent = out;
</script>`;
  const docHtml = renderSandboxedPart({ body: evil, css: "", origin: server.url });

  await page.goto(server.url);
  // Mount the rich frame exactly as SandboxedPart does: a blob: URL document in
  // an iframe sandboxed with allow-scripts and NO allow-same-origin.
  await page.evaluate((html) => {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const f = document.createElement("iframe");
    f.id = "rich-probe";
    f.setAttribute("sandbox", "allow-scripts");
    f.src = url;
    document.body.append(f);
  }, docHtml);

  // The inline script ran (CSP allows it) and self-reported into its own DOM:
  // window.origin is the opaque "null", and its write to the parent board threw.
  const probe = page.frameLocator("#rich-probe").locator("#r");
  await expect(probe).toContainText("null", { timeout: 10_000 });
  await expect(probe).toContainText("parent-blocked");
  await expect(probe).not.toContainText("REACHED-PARENT");
  // The board document itself is untouched: the escape never reached it.
  await expect.poll(() => page.evaluate(() => document.body.dataset.pwned)).toBeUndefined();
});

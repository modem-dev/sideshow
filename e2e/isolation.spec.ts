import { expect, publish, publishParts, test } from "./fixtures.ts";

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

// Rich parts (markdown/code/diff/terminal) now render server-side and are served
// from /s/:id by real URL, with the SAME load-bearing `sandbox` CSP response
// header as html parts (opaque origin on any load) plus a TIGHTER in-doc CSP
// than html parts: no connect-src and no CDN/board script source, so even if a
// renderer regression let agent markup through, a script could neither phone
// home nor reach the board. This proves both: (a) agent markup in the source is
// neutralized by the renderer (markdown-it html:false), and (b) the document is
// opaque-origin with that tight CSP — defense in depth behind the escape.
test("a rich part served from /s/:id is opaque-origin with a tight, exfil-proof CSP", async ({
  page,
  server,
  request,
}) => {
  // A raw <script> in the markdown source that, if it ever executed, would flag
  // the board. The renderer must escape it to text; the sandbox is the backstop.
  const { id } = await publishParts(server.url, {
    title: "rich-isolation",
    agent: "e2e",
    parts: [
      {
        kind: "markdown",
        markdown: "# Heading\n\n<script>parent.document.body.dataset.pwned='1'</script>\n",
      },
    ],
  });

  // The response itself forces the opaque-origin sandbox (the load-bearing
  // header — not just the iframe attribute, so a top-level open is contained).
  const served = await request.get(`${server.url}/s/${id}?part=0`);
  expect(served.headers()["content-security-policy"]).toBe("sandbox allow-scripts");
  const docText = await served.text();
  // The injected <script> was escaped, not emitted live...
  expect(docText).not.toContain("<script>parent.document");
  // ...and the in-doc rich CSP has NO connect-src at all (no exfil channel) and
  // its script-src is inline-only — no board origin, no CDN — unlike an html
  // part. (img-src does include the board origin so inline /a/:id images load;
  // that's not a script/exfil vector.)
  const meta = docText.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
  expect(meta).not.toContain("connect-src");
  const scriptSrc = meta.match(/script-src ([^;]+)/)?.[1] ?? "";
  expect(scriptSrc).toBe("'unsafe-inline'");

  // Loaded top-level, the document is opaque-origin (window.origin === "null"),
  // so even a hypothetical escaped script couldn't read board cookies/storage.
  await page.goto(`${server.url}/s/${id}?part=0`);
  await expect(page.locator("h1")).toHaveText("Heading"); // it rendered
  expect(await page.evaluate(() => window.origin)).toBe("null");
  expect(await page.evaluate(() => document.body.dataset.pwned)).toBeUndefined();
});

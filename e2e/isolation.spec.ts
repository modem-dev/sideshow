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

test("a rich frame runs only its nonced bridge, not injected scripts or handlers", async ({
  page,
  server,
}) => {
  const srcdoc = renderSandboxedPart({
    body: `<div id="probe">content</div>
<script>parent.document.body.dataset.richEscape = 'script'</script>
<img src="data:image/png;base64,!" onerror="parent.document.body.dataset.richEscape = 'handler'">`,
    css: "",
    origin: server.url,
  });

  await page.goto(server.url);
  await page.evaluate((doc) => {
    document.body.replaceChildren();
    delete document.body.dataset.richEscape;
    (window as Window & { richBridgeReady?: boolean }).richBridgeReady = false;
    window.addEventListener("message", (event) => {
      if (event.data?.__sideshow && event.data.type === "resize") {
        (window as Window & { richBridgeReady?: boolean }).richBridgeReady = true;
      }
    });
    const frame = document.createElement("iframe");
    frame.id = "rich-probe";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.srcdoc = doc;
    document.body.append(frame);
  }, srcdoc);

  await expect(page.frameLocator("#rich-probe").locator("#probe")).toHaveText("content");
  await expect.poll(() => page.evaluate(() => document.body.dataset.richEscape)).toBeUndefined();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { richBridgeReady?: boolean }).richBridgeReady === true,
      ),
    )
    .toBe(true);
  await expect(page.locator("#rich-probe")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin",
  );
});

import { expect, publishParts, test } from "./fixtures.ts";

// The session export is a trusted shell document that embeds every surface as a
// sandboxed srcdoc iframe. This spec proves the healthy path end-to-end on real
// Chromium and WebKit: the srcdoc frames lay out and the bridge sizes them (the
// reason the retry + staggered timers exist), and a script inside an html
// surface still can't reach the shell — the opaque origin holds even without a
// /s/:id URL. (The Chrome 149 field trial itself can't be reproduced in
// Playwright per commit 5e3f292; the retry ships on the in-repo precedent.)

const MD = [
  "## Exported plan",
  "",
  "Prose that wraps across several lines so the rendered markdown is clearly",
  "taller than the 24px minimum frame height once the bridge measures it.",
  "",
  "- one",
  "- two",
  "- three",
].join("\n");

// A probe that tries to read the shell document across the sandbox boundary.
// The frame is sandboxed WITHOUT allow-same-origin, so `parent.document` throws
// a SecurityError — the frame is at an opaque origin. It self-reports into its
// own DOM (the only channel it has).
const PROBE = `<div id="r">running</div>
<script>
  try {
    var leaked = parent.document && parent.document.querySelector('.ss-card');
    document.getElementById('r').textContent = leaked ? 'LEAKED' : 'blocked';
  } catch (e) {
    document.getElementById('r').textContent = 'blocked';
  }
</script>`;

test("a session exports to a self-contained HTML shell whose frames lay out and stay isolated", async ({
  page,
  server,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const first = await publishParts(server.url, {
    title: "Probe card",
    agent: "e2e",
    parts: [{ kind: "html", html: PROBE }],
  });
  await publishParts(server.url, {
    title: "Markdown card",
    agent: "e2e",
    session: first.sessionId,
    parts: [{ kind: "markdown", markdown: MD }],
  });

  await page.goto(`${server.url}/api/sessions/${first.sessionId}/export`);

  // Two cards, chronological: the probe first, the markdown second.
  await expect(page.locator(".ss-card")).toHaveCount(2);

  // Every embedded surface is sandboxed with no allow-same-origin.
  await expect(page.locator("iframe.ss-frame:not(.mdframe)")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  await expect(page.locator("iframe.mdframe")).toHaveAttribute("sandbox", "allow-scripts");

  // (a) the markdown frame's bridge reports height, so it grows past the min.
  await expect
    .poll(async () => (await page.locator("iframe.mdframe").boundingBox())?.height ?? 0, {
      timeout: 10_000,
    })
    .toBeGreaterThan(60);

  // (b) the html surface's script cannot reach the shell — opaque origin holds.
  const probe = page.frameLocator("iframe.ss-frame:not(.mdframe)").locator("#r");
  await expect(probe).toHaveText("blocked", { timeout: 10_000 });
  await expect(probe).not.toContainText("LEAKED");

  // (c) no CSP / security console errors from the shell or its frames.
  expect(consoleErrors.filter((e) => /content security policy|security|refused/i.test(e))).toEqual(
    [],
  );
});

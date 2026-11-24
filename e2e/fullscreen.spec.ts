import { expect, publishParts, serveEmbedBundle, test } from "./fixtures.ts";

// html-part iframe (the sandboxed /s/:id doc).
const PART_FRAME = 'iframe[src*="/s/"]';

// A deck-like surface with its own Fullscreen button, written the way an agent
// would write it: the STANDARD Fullscreen API, nothing sideshow-specific. The
// counter is in-document state — it only survives if the viewer expands the
// same iframe instead of loading the surface again.
const STAGE = `
<div id="stage" style="padding:24px">
  <button id="next">next</button>
  <button id="fs">fullscreen</button>
  <span id="n">1</span>
  <span id="state">windowed</span>
</div>
<script>
  var n = 1;
  document.getElementById('next').onclick = function () {
    document.getElementById('n').textContent = String(++n);
  };
  document.getElementById('fs').onclick = function () {
    var stage = document.getElementById('stage');
    var p = document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen();
    p.catch(function (e) { document.getElementById('state').textContent = 'denied'; });
  };
  document.addEventListener('fullscreenchange', function () {
    document.getElementById('state').textContent =
      document.fullscreenElement === document.getElementById('stage') ? 'fullscreen' : 'windowed';
  });
</script>`;

test("the expand button fills the viewer with the same frame and Esc restores the card", async ({
  page,
  server,
}) => {
  await publishParts(server.url, {
    title: "Deck",
    agent: "e2e",
    parts: [{ kind: "html", html: STAGE }],
  });
  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)").first();
  const shell = card.locator(".surface-shell");
  const iframe = card.locator(PART_FRAME);
  const frame = card.frameLocator(PART_FRAME);

  await frame.locator("#next").click();
  await expect(frame.locator("#n")).toHaveText("2");
  const cardHeight = await iframe.evaluate((el) => (el as HTMLElement).style.height);

  await shell.hover();
  await shell.getByRole("button", { name: "Expand this surface" }).click();
  await expect(shell).toHaveClass(/expanded/);
  await expect(shell).toHaveAttribute("role", "dialog");
  // The frame now spans (nearly) the whole viewer window…
  const viewport = page.viewportSize()!;
  await expect
    .poll(async () => (await iframe.boundingBox())!.width)
    .toBeGreaterThan(viewport.width - 60);
  // …and it is the SAME document: in-frame state survived the expansion.
  await expect(frame.locator("#n")).toHaveText("2");
  // The content is told, through the standard API (the host expanded the root).
  await expect
    .poll(() => frame.locator("body").evaluate(() => document.fullscreenElement?.tagName))
    .toBe("HTML");

  await page.keyboard.press("Escape");
  await expect(shell).not.toHaveClass(/expanded/);
  await expect(frame.locator("#n")).toHaveText("2");
  // Back in the card at its card-sized height, not the expanded one.
  await expect
    .poll(() => iframe.evaluate((el) => (el as HTMLElement).style.height))
    .toBe(cardHeight);
  await expect(shell.getByRole("button", { name: "Expand this surface" })).toBeFocused();
});

test("a surface's own requestFullscreen() expands it in place, and exitFullscreen() returns", async ({
  page,
  server,
}) => {
  await publishParts(server.url, {
    title: "Deck",
    agent: "e2e",
    parts: [{ kind: "html", html: STAGE }],
  });
  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)").first();
  const shell = card.locator(".surface-shell");
  const frame = card.frameLocator(PART_FRAME);

  await frame.locator("#next").click();
  // A real click inside the sandboxed frame: the frame has no fullscreen
  // permission, so this only works because the bridge routes it to the host.
  await frame.locator("#fs").click();
  await expect(frame.locator("#state")).toHaveText("fullscreen");
  // Real browser fullscreen where the engine allows it, the window-filling
  // dialog otherwise — expanded either way.
  await expect(shell).toHaveClass(/expanded/);
  await expect(frame.locator("#n")).toHaveText("2");
  // The requesting element is stretched over the whole frame, like :fullscreen.
  await expect
    .poll(() =>
      frame.locator("#stage").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (
          el.hasAttribute("data-sideshow-fullscreen") &&
          r.width === window.innerWidth &&
          r.height === window.innerHeight
        );
      }),
    )
    .toBe(true);

  await frame.locator("#fs").click();
  await expect(frame.locator("#state")).toHaveText("windowed");
  await expect(shell).not.toHaveClass(/expanded/);
  await expect(frame.locator("#n")).toHaveText("2");
});

test("a surface cannot take over the viewer without a user gesture", async ({ page, server }) => {
  // Untrusted content asking for fullscreen on its own, with nobody clicking.
  await publishParts(server.url, {
    title: "Takeover",
    agent: "e2e",
    parts: [
      {
        kind: "html",
        html: `<p>hello</p><script>
          setTimeout(function () {
            document.body.requestFullscreen().then(
              function () { console.log('takeover: granted'); },
              function () { console.log('takeover: denied'); }
            );
          }, 300);
        </script>`,
      },
    ],
  });
  // Deliberately no interaction (and no in-frame assertions, which would count
  // as one) before the request settles: the outcome arrives over the console.
  const outcome = page.waitForEvent("console", (m) => m.text().startsWith("takeover:"));
  await page.goto(server.url);
  expect((await outcome).text()).toBe("takeover: denied");
  await expect(page.locator(".surface-shell.expanded")).toHaveCount(0);
});

// The embedded engine renders into a shadow root, where the fullscreen element
// and the key handling are read off the shadow root rather than `document`.
const embedHtml = (sessionId: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#m{position:fixed;inset:0}</style></head>
<body><div id="m"></div>
<script type="module">
  import { mountViewer } from "/__embed/engine.js";
  mountViewer(document.getElementById("m"), {
    basePath: "",
    router: {
      get: () => ({ sessionId: ${JSON.stringify(sessionId)} }),
      navigate() {},
      subscribe() { return () => {}; },
    },
  });
</script></body></html>`;

test("embedded engine: a surface's requestFullscreen() expands and collapses in the shadow root", async ({
  page,
  server,
}) => {
  const post = await publishParts(server.url, {
    title: "Deck",
    agent: "e2e",
    parts: [{ kind: "html", html: STAGE }],
  });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.route("**/__embedtest-fullscreen", (route) =>
    route.fulfill({ contentType: "text/html", body: embedHtml(post.sessionId) }),
  );
  await serveEmbedBundle(page);
  await page.goto(`${server.url}/__embedtest-fullscreen`);

  const card = page.locator(".card:not(#whatsNew)").first();
  const shell = card.locator(".surface-shell");
  const frame = card.frameLocator(PART_FRAME);

  await frame.locator("#fs").click();
  await expect(frame.locator("#state")).toHaveText("fullscreen");
  await expect(shell).toHaveClass(/expanded/);

  await frame.locator("#fs").click();
  await expect(frame.locator("#state")).toHaveText("windowed");
  await expect(shell).not.toHaveClass(/expanded/);

  // The viewer's own expand button and Esc work the same way there.
  await shell.hover();
  await shell.getByRole("button", { name: "Expand this surface" }).click();
  await expect(shell).toHaveClass(/expanded/);
  await page.keyboard.press("Escape");
  await expect(shell).not.toHaveClass(/expanded/);
});

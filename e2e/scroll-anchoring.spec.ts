// Scroll anchoring under slow networks. Surface iframes report their real
// heights whenever their sandboxed documents get around to it — on slow wifi
// that's seconds after the deep-link scroll has "settled", and a CDN-loaded
// surface (mermaid) resizes long after its frame's load event. The engine must
// (a) keep a deep-linked post anchored while surfaces above it settle, however
// late, (b) do so in every browser — WebKit has no native scroll anchoring,
// and Chrome suppresses its own at scrollTop 0 — and (c) never fight the user:
// real input ends the deep-link pin instantly, and thereafter scrollTop
// compensation keeps the view stable without moving it.
import { expect, publish, test } from "./fixtures.ts";

// A surface whose frame loads fast but grows late — the CDN-mermaid shape.
const lateGrower = (delayMs: number, height = 900) => `
  <div id="grower" style="height:40px;padding:16px;overflow:hidden">
    <h2>Late grower</h2>
  </div>
  <script>
    setTimeout(() => {
      document.getElementById("grower").style.height = "${height}px";
    }, ${delayMs});
  </script>
`;

const gapToBottom = (page: import("@playwright/test").Page) =>
  page.locator("main").evaluate((main) => {
    return Math.round(main.scrollHeight - main.clientHeight - main.scrollTop);
  });

test("deep-linked post stays anchored while surfaces above it grow late", async ({
  page,
  server,
}) => {
  // Two growers: one inside any plausible settle window (1s), one well past it
  // (3.5s) — a fix that waits for a quiet period instead of observing height
  // changes loses to the second one.
  const top = await publish(server.url, {
    html: lateGrower(1000),
    title: "Grower 1s",
    agent: "pi",
  });
  await publish(server.url, {
    html: lateGrower(3500, 700),
    title: "Grower 3.5s",
    agent: "pi",
    session: top.sessionId,
  });
  const target = await publish(server.url, {
    html: '<div style="height:180px"><h2>Target</h2></div>',
    title: "Target",
    agent: "pi",
    session: top.sessionId,
  });

  await page.goto(`${server.url}/session/${top.sessionId}/s/${target.id}`);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(3);

  // Wait for the second grower to fire.
  const frame2 = page.locator(`.card[data-id="${top.id}"] + .card iframe`).first();
  await expect
    .poll(async () => (await frame2.boundingBox())?.height ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(600);

  await expect.poll(() => gapToBottom(page), { timeout: 3000 }).toBeLessThanOrEqual(4);
  await expect(page).toHaveURL(new RegExp(`/session/${top.sessionId}/s/${target.id}$`));
});

test("slow network: deep-linked last post is in view once surfaces settle", async ({
  page,
  server,
}) => {
  // Model a slow-wifi reload faithfully: EVERY surface document is delayed, so
  // at deep-link time the stream is collapsed 24px strips and the initial
  // scroll lands near scrollTop 0 — where Chrome suppresses native anchoring.
  const posts = [];
  let sessionId: string | undefined;
  for (let i = 0; i < 8; i++) {
    const p = await publish(server.url, {
      html: `<div style="height:${380 + i * 20}px"><h2>Post ${i + 1}</h2></div>`,
      title: `Post ${i + 1}`,
      agent: "pi",
      ...(sessionId ? { session: sessionId } : {}),
    });
    sessionId = p.sessionId;
    posts.push(p);
  }
  const target = posts[posts.length - 1];

  await page.route("**/s/*", async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });

  await page.goto(`${server.url}/session/${sessionId}/s/${target.id}`);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(8);

  await expect
    .poll(
      () =>
        page
          .locator(".card:not(#whatsNew) iframe")
          .evaluateAll((frames) => frames.every((f) => f.getBoundingClientRect().height > 300)),
      { timeout: 15_000 },
    )
    .toBe(true);

  await expect
    .poll(
      () =>
        page.locator(`.card[data-id="${target.id}"]`).evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.top < window.innerHeight && r.bottom > 0;
        }),
      { timeout: 3000 },
    )
    .toBe(true);
});

test("user scroll ends the deep-link pin — a stalled surface can't hold the view", async ({
  page,
  server,
}) => {
  const top = await publish(server.url, {
    html: '<div style="height:400px"><h2>Stalled</h2></div>',
    title: "Stalled",
    agent: "pi",
  });
  await publish(server.url, {
    html: '<div style="height:600px"><h2>Middle</h2></div>',
    title: "Middle",
    agent: "pi",
    session: top.sessionId,
  });
  const target = await publish(server.url, {
    html: '<div style="height:300px"><h2>Target</h2></div>',
    title: "Target",
    agent: "pi",
    session: top.sessionId,
  });

  // The first card's surface fetch stalls (slow wifi) far past the test.
  await page.route(`**/s/${top.id}?*`, async (route) => {
    await new Promise((r) => setTimeout(r, 20_000));
    await route.continue().catch(() => {});
  });

  await page.goto(`${server.url}/session/${top.sessionId}/s/${target.id}`);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(3);
  await page.waitForTimeout(2500); // other frames sized, pin armed on the stalled one

  const readTop = () => page.locator("main").evaluate((m) => m.scrollTop);
  const anchored = await readTop();

  // The user scrolls up to read something.
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(200);
  const afterUserScroll = await readTop();
  expect(afterUserScroll).toBeLessThan(anchored - 100);

  // 1.5s later the view is still theirs — nothing yanked it back.
  await page.waitForTimeout(1500);
  expect(Math.abs((await readTop()) - afterUserScroll)).toBeLessThanOrEqual(50);
});

test("reading position is preserved when a surface above the viewport grows late", async ({
  page,
  server,
}) => {
  // No deep link at all: the user opens a session, scrolls down to read, and a
  // surface far above the viewport finally reports its height. scrollTop
  // compensation must keep the visible content exactly where it was (WebKit
  // has no native anchoring; Chrome's native anchoring is disabled by
  // overflow-anchor so the engine's own compensation is what's under test).
  const top = await publish(server.url, {
    html: lateGrower(3000),
    title: "Grower",
    agent: "pi",
  });
  for (let i = 0; i < 4; i++) {
    await publish(server.url, {
      html: `<div style="height:500px"><h2>Filler ${i + 1}</h2></div>`,
      title: `Filler ${i + 1}`,
      agent: "pi",
      session: top.sessionId,
    });
  }
  const last = await publish(server.url, {
    html: '<div style="height:300px"><h2>Reading here</h2></div>',
    title: "Reading here",
    agent: "pi",
    session: top.sessionId,
  });

  await page.goto(`${server.url}/session/${top.sessionId}`);
  await expect(page.locator(".card:not(#whatsNew)")).toHaveCount(6);
  // Let the fast surfaces size, then scroll to the bottom like a reader would.
  await page.waitForTimeout(1000);
  await page.locator(`.card[data-id="${last.id}"]`).scrollIntoViewIfNeeded();

  const readingTop = () =>
    page
      .locator(`.card[data-id="${last.id}"]`)
      .evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const before = await readingTop();

  // The grower fires at 3s, far above the viewport.
  const growerFrame = page.locator(`.card[data-id="${top.id}"] iframe`).first();
  await expect
    .poll(async () => (await growerFrame.boundingBox())?.height ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(700);
  await page.waitForTimeout(300);

  expect(Math.abs((await readingTop()) - before)).toBeLessThanOrEqual(4);
});

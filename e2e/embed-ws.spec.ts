// End-to-end proof that an embedding host can opt the viewer engine into the
// WebSocket live-update transport while keeping the same event payloads and
// reconciliation behavior as the default EventSource path.
import { expect, publish, serveEmbedBundle, test } from "./fixtures.ts";

const embedHtml = (sessionId: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#m{position:fixed;inset:0}</style></head>
<body><div id="m"></div>
<script>
  window.__SIDESHOW_PUBLIC_READ__ = "session";
  const NativeSetInterval = window.setInterval.bind(window);
  window.setInterval = (cb, ms, ...args) => NativeSetInterval(cb, ms === 30000 ? 10 : ms, ...args);
  const sockets = [];
  const sent = [];
  const urls = [];
  const closedSockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = FakeWebSocket.CONNECTING;
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    constructor(url) {
      this.url = url;
      sockets.push(this);
      urls.push(url);
      setTimeout(() => {
        if (this.readyState !== FakeWebSocket.CONNECTING) return;
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }, 0);
    }
    send(data) {
      sent.push(String(data));
      if (data === "ping") setTimeout(() => this.onmessage?.({ data: "pong" }), 0);
    }
    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      closedSockets.push(this);
      this.onclose?.(new CloseEvent("close"));
    }
    deliver(event) {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  }
  window.WebSocket = FakeWebSocket;
  window.__wsHarness = {
    sent,
    urls,
    closedCount() { return closedSockets.length; },
    deliver(event) { sockets.at(-1)?.deliver(event); },
    closeLatest() { sockets.at(-1)?.close(); },
  };
</script>
<script type="module">
  import { mountViewer } from "/__embed/engine.js";
  window.__viewerHandle = mountViewer(document.getElementById("m"), {
    basePath: "",
    layout: "stream",
    readonly: true,
    liveTransport: "ws",
    router: {
      get: () => ({ sessionId: ${JSON.stringify(sessionId)} }),
      navigate() {},
      subscribe() { return () => {}; },
    },
  });
</script></body></html>`;

test("embedded engine: liveTransport:'ws' applies events, reconnects, and heartbeats", async ({
  page,
  server,
}) => {
  const first = await publish(
    server.url,
    { html: "<p>first websocket card</p>", title: "First WS", agent: "e2e" },
    "",
  );

  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("[console]", m.text()));

  await page.route("**/__embedtest", (route) =>
    route.fulfill({ contentType: "text/html", body: embedHtml(first.sessionId) }),
  );
  await serveEmbedBundle(page);

  await page.goto(`${server.url}/__embedtest`);
  await expect(page.locator(".card-title")).toContainText("First WS");

  await expect
    .poll(() => page.evaluate(() => window.__wsHarness.urls[0]))
    .toContain(`/api/events?session=${encodeURIComponent(first.sessionId)}`);
  await expect.poll(() => page.evaluate(() => window.__wsHarness.sent.includes("ping"))).toBe(true);

  const second = await publish(
    server.url,
    {
      html: "<p>second websocket card</p>",
      title: "Second WS",
      agent: "e2e",
      session: first.sessionId,
    },
    "",
  );
  await page.evaluate((event) => window.__wsHarness.deliver(event), {
    type: "post-created",
    id: second.id,
    sessionId: second.sessionId,
    version: second.version,
  });
  await expect(page.locator(".card-title")).toContainText(["First WS", "Second WS"]);

  await page.evaluate(() => window.__wsHarness.closeLatest());
  const third = await publish(
    server.url,
    {
      html: "<p>third websocket card</p>",
      title: "Third WS",
      agent: "e2e",
      session: first.sessionId,
    },
    "",
  );
  expect(third.sessionId).toBe(first.sessionId);

  await expect.poll(() => page.evaluate(() => window.__wsHarness.urls.length)).toBeGreaterThan(1);
  await expect(page.locator(".card-title")).toContainText(["First WS", "Second WS", "Third WS"]);

  const socketsBeforeDispose = await page.evaluate(() => window.__wsHarness.urls.length);
  await page.evaluate(() => window.__viewerHandle.dispose());
  await expect.poll(() => page.evaluate(() => window.__wsHarness.closedCount())).toBeGreaterThan(1);
  await page.waitForTimeout(1100);
  expect(await page.evaluate(() => window.__wsHarness.urls.length)).toBe(socketsBeforeDispose);
});

declare global {
  interface Window {
    __viewerHandle: { dispose(): void };
    __wsHarness: {
      sent: string[];
      urls: string[];
      closedCount(): number;
      deliver(event: unknown): void;
      closeLatest(): void;
    };
  }
}

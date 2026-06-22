import { expect, publishParts, test } from "./fixtures.ts";

const ESC = "\x1b";
// a green word via an SGR escape, plus raw HTML that must never become a node
const TEXT = `${ESC}[32mbuild ok${ESC}[0m\n<img src=x onerror=alert(1)> done`;

test("a terminal part renders ANSI in a sandbox iframe, escaping raw HTML", async ({
  page,
  server,
}) => {
  await publishParts(server.url, {
    title: "Logs",
    agent: "e2e",
    parts: [{ kind: "terminal", title: "build", text: TEXT }],
  });

  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)").first();

  // terminal output renders inside a sandbox iframe. It is same-origin to avoid
  // Chrome 149's opaque-origin srcdoc layout bug; CSP blocks non-nonced scripts.
  await expect(card.locator("iframe.termframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin",
  );
  const frame = card.frameLocator("iframe.termframe");

  // SGR escape became an inline-styled span (a color), not literal text
  await expect(frame.locator(".term-body span[style*='color']").first()).toBeVisible();
  await expect(frame.locator(".term-title")).toHaveText("build");
  // raw HTML in the stream is escaped to text, never a live <img>
  await expect(frame.locator("img")).toHaveCount(0);
  await expect(frame.locator(".term-body")).toContainText("<img src=x onerror=alert(1)>");
});

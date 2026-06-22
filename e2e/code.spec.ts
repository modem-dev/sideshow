import { expect, publishParts, test } from "./fixtures.ts";

test("a code part keeps copy behavior under the nonce-only rich-frame CSP", async ({
  page,
  server,
  context,
  browserName,
}) => {
  const code = `const closingTag = "</script>";\r\nconsole.log(closingTag);`;
  await publishParts(server.url, {
    title: "code",
    parts: [{ kind: "code", code, language: "ts", title: "example.ts", lineStart: 40 }],
  });
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  await page.goto(server.url);

  const card = page.locator(".card:not(#whatsNew)").first();
  await expect(card.locator("iframe.codeframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin",
  );
  const frame = card.frameLocator("iframe.codeframe");
  await expect(frame.locator(".code-filename")).toContainText("example.ts:40-41");
  await frame.locator(".copy-btn").click();
  await expect(frame.locator(".copy-btn")).toHaveText("Copied!");
  if (browserName === "chromium") {
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  }
});

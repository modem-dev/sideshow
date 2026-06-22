import { expect, publishParts, test } from "./fixtures.ts";

test("a diff part renders a highlighted diff inside a sandbox iframe", async ({ page, server }) => {
  await publishParts(server.url, {
    title: "Change",
    agent: "e2e",
    parts: [
      {
        kind: "diff",
        files: [
          {
            filename: "greet.ts",
            before: "export const greet = () => 'hi';\n",
            after: "export const greet = (name: string) => `hi ${name}`;\n",
          },
        ],
      },
    ],
  });

  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)").first();

  // the diff renders in a sandbox iframe. It is same-origin to avoid Chrome
  // 149's opaque-origin srcdoc layout bug; CSP blocks all non-nonced scripts.
  await expect(card.locator("iframe.diffframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin",
  );
  const frame = card.frameLocator("iframe.diffframe");

  // the @pierre/diffs SSR fragment mounts in a declarative shadow root; its
  // content (filename + the changed code) renders inside the frame
  await expect(frame.locator("diffs-container")).toBeVisible();
  await expect(frame.locator("body")).toContainText("greet.ts");
  await expect(frame.locator("body")).toContainText("name");
  // structured output, not the (viewer-side) error fallback
  await expect(card.locator(".diff-error")).toHaveCount(0);
});

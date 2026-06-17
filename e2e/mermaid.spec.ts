import { expect, publishParts, test } from "./fixtures.ts";

const DIAGRAM = [
  "graph TD",
  "  A[Start] --> B{Choice}",
  "  B -->|yes| C[Do it]",
  "  B -->|no| D[Skip]",
].join("\n");

test("a mermaid part renders a diagram as inline SVG in the viewer", async ({ page, server }) => {
  await publishParts(server.url, {
    title: "Flow",
    agent: "e2e",
    parts: [{ kind: "mermaid", mermaid: DIAGRAM }],
  });

  await page.goto(server.url);
  const card = page.locator(".card:not(#sessionThread)");
  const mermaid = card.locator(".mermaidpart");

  // rendered natively in the viewer document (no sandboxed iframe), as an SVG
  const svg = mermaid.locator("svg");
  await expect(svg).toBeVisible();
  // the node labels made it into the rendered graph
  await expect(mermaid).toContainText("Start");
  await expect(mermaid).toContainText("Choice");
  // it's structured SVG, not an error fallback
  await expect(mermaid.locator(".mermaid-error")).toHaveCount(0);
});

test("an invalid mermaid part shows the source in an error fallback, not a crash", async ({
  page,
  server,
}) => {
  await publishParts(server.url, {
    title: "Broken",
    agent: "e2e",
    // no diagram-type keyword → mermaid can't even pick a parser, so it throws
    parts: [{ kind: "mermaid", mermaid: "this is definitely not a valid diagram" }],
  });

  await page.goto(server.url);
  const card = page.locator(".card:not(#sessionThread)");
  const err = card.locator(".mermaidpart .mermaid-error");
  await expect(err).toBeVisible();
  // the original source is echoed so the agent can see what failed
  await expect(err.locator("pre")).toContainText("not a valid diagram");
});

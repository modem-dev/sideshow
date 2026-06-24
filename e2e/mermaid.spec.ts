import { expect, publishParts, test } from "./fixtures.ts";

const DIAGRAM = [
  "graph TD",
  "  A[Start] --> B{Choice}",
  "  B -->|yes| C[Do it]",
  "  B -->|no| D[Skip]",
].join("\n");

// Mermaid can't render without a DOM, so the server emits a self-rendering doc
// that imports mermaid from the CDN and renders in the sandboxed iframe (the
// "(B)" path). These tests stub that CDN import so they're hermetic and exercise
// OUR loader wiring — initialize → render → inject SVG, and the error fallback —
// rather than the real mermaid parser (now mermaid's own concern) or the
// network. The diagram source is echoed back so the stub can prove it reached
// mermaid.render with the right input.
test("a mermaid part renders inside an opaque-origin frame served from /s", async ({
  page,
  server,
}) => {
  // Stub mermaid: echo the source into an <svg> so we can assert it rendered
  // with our input. Real parsing is mermaid's job; we test the wiring.
  await page.route("https://esm.sh/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body:
        "export default { initialize(){}, render(id, src){ " +
        "return Promise.resolve({ svg: '<svg xmlns=\"http://www.w3.org/2000/svg\"><text>' + src + '</text></svg>' }); } };",
    }),
  );

  await publishParts(server.url, {
    title: "Flow",
    agent: "e2e",
    parts: [{ kind: "mermaid", mermaid: DIAGRAM }],
  });

  await page.goto(server.url);
  const card = page.locator(".card:not(#sessionThread)");

  // the diagram renders inside an opaque-origin sandbox iframe — a second
  // boundary behind mermaid's DOMPurify. No allow-same-origin.
  await expect(card.locator("iframe.mermaidframe")).toHaveAttribute("sandbox", "allow-scripts");
  const frame = card.frameLocator("iframe.mermaidframe");

  const svg = frame.locator("svg");
  await expect(svg).toBeVisible();
  // the source reached mermaid.render and the returned SVG was injected
  await expect(frame.locator("body")).toContainText("Start");
  await expect(frame.locator("body")).toContainText("Choice");
});

test("an invalid mermaid part shows the source in an error fallback, not a crash", async ({
  page,
  server,
}) => {
  // Stub mermaid: render() rejects, exercising our in-frame error fallback.
  await page.route("https://esm.sh/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body:
        "export default { initialize(){}, render(){ " +
        "return Promise.reject(new Error('parse failure')); } };",
    }),
  );

  await publishParts(server.url, {
    title: "Broken",
    agent: "e2e",
    parts: [{ kind: "mermaid", mermaid: "this is definitely not a valid diagram" }],
  });

  await page.goto(server.url);
  const card = page.locator(".card:not(#sessionThread)");
  const frame = card.frameLocator("iframe.mermaidframe");
  const err = frame.locator(".mmd-error");
  await expect(err).toBeVisible();
  // the original source is echoed so the agent can see what failed
  await expect(err.locator("pre")).toContainText("not a valid diagram");
});

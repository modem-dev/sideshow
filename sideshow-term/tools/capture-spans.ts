// Screenshot capture (Bun). Renders STML — either a single snippet, or a mock
// of the live viewer chrome — into the headless test renderer, then dumps the
// per-cell color/char data (captureSpans) as JSON for the Python rasterizer.

import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildDocument } from "../src/render.ts";
import { resolveColor } from "../src/theme.ts";

const TERM_BG = "#0d1117";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "snippet" },
    file: { type: "string" },
    width: { type: "string" },
    height: { type: "string" },
  },
});

const width = values.width ? Number(values.width) : 80;
const height = values.height ? Number(values.height) : 40;

function serColor(c: { buffer: ArrayLike<number> }): [number, number, number, number] {
  const b = Array.from(c.buffer);
  const scale = (v: number) => (v <= 1 ? Math.round(v * 255) : Math.round(v));
  return [
    scale(b[0]),
    scale(b[1]),
    scale(b[2]),
    b[3] <= 1 ? Math.round(b[3] * 255) : Math.round(b[3]),
  ];
}

const { renderer, renderOnce, captureSpans } = await createTestRenderer({
  width,
  height,
  backgroundColor: TERM_BG,
});

if (values.mode === "viewer") {
  buildViewer(renderer);
} else {
  const markup = readFileSync(values.file ?? 0, "utf8");
  const { root } = buildDocument(renderer, markup);
  renderer.root.add(root);
}

await renderOnce();
const frame = captureSpans();
const out = {
  cols: frame.cols,
  rows: frame.rows,
  bg: serColor({ buffer: hexBuffer(TERM_BG) }),
  lines: frame.lines.map((line) => ({
    spans: line.spans.map((s) => ({
      text: s.text,
      fg: serColor(s.fg),
      bg: serColor(s.bg),
      attributes: s.attributes,
      width: s.width,
    })),
  })),
};
console.log(JSON.stringify(out));
process.exit(0);

function hexBuffer(hex: string): number[] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    255,
  ];
}

// A faithful mock of the watch viewer chrome (same theme + buildDocument for
// the main pane) so the screenshot shows the real app, not just a snippet.
function buildViewer(r: typeof renderer) {
  const muted = resolveColor("muted") ?? undefined;
  const heading = resolveColor("heading") ?? undefined;
  const subtle = resolveColor("subtle") ?? undefined;

  const rootCol = new BoxRenderable(r, { flexDirection: "column", width: "100%", height: "100%" });
  r.root.add(rootCol);

  rootCol.add(
    new TextRenderable(r, {
      content: "sideshow-term  ·  http://localhost:8228  ·  3 snippets",
      paddingLeft: 1,
      height: 1,
      fg: heading,
    }),
  );

  const body = new BoxRenderable(r, { flexDirection: "row", flexGrow: 1, width: "100%" });
  rootCol.add(body);

  const sidebar = new BoxRenderable(r, {
    flexDirection: "column",
    width: 30,
    border: true,
    borderColor: muted,
    title: "snippets",
    paddingLeft: 1,
  });
  body.add(sidebar);

  const sessions = [
    { title: "Payments refactor", snippets: ["Charge flow", "Retry policy", "Status"] },
  ];
  const selected = "Charge flow";
  for (const session of sessions) {
    sidebar.add(new TextRenderable(r, { content: session.title, fg: muted }));
    for (const title of session.snippets) {
      const isSel = title === selected;
      sidebar.add(
        new TextRenderable(r, {
          content: `${isSel ? "› " : "  "}${title}`,
          fg: isSel ? heading : undefined,
          bg: isSel ? subtle : undefined,
        }),
      );
    }
  }

  const main = new BoxRenderable(r, {
    flexDirection: "column",
    flexGrow: 1,
    paddingLeft: 1,
    paddingRight: 1,
  });
  body.add(main);
  main.add(new TextRenderable(r, { content: "Charge flow  ·  v1", height: 1, fg: heading }));
  const scroll = new ScrollBoxRenderable(r, {
    flexGrow: 1,
    width: "100%",
    rootOptions: { flexGrow: 1 },
  });
  main.add(scroll);
  const { root } = buildDocument(
    r,
    readFileSync(new URL("../examples/auth-flow.stml", import.meta.url), "utf8"),
  );
  scroll.content.add(root);

  rootCol.add(
    new TextRenderable(r, {
      content: "↑/↓ select   [ / ] scroll   r refresh   q quit",
      paddingLeft: 1,
      height: 1,
      fg: muted,
    }),
  );
}

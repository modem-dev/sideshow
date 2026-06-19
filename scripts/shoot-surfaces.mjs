// Regenerates the README surface gallery (docs/surfaces/*.png): boots a fresh
// server, publishes one clean card per part kind from scripts/surface-examples/,
// and screenshots each card in a dark-mode Chromium at 2x. Run after changing a
// part renderer or an example:
//
//   node scripts/shoot-surfaces.mjs
//
// The chart for the image example is rendered by Playwright itself (the example
// SVG, screenshotted to a PNG and uploaded as an asset) so there is no system
// image-conversion dependency.

import { chromium } from "@playwright/test";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EX = join(ROOT, "scripts", "surface-examples");
const OUT = join(ROOT, "docs", "surfaces");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => readFileSync(join(EX, f), "utf8");
const E = "\x1b["; // ANSI CSI

execSync("npx vite build", { cwd: ROOT, stdio: "inherit" });

const dataDir = mkdtempSync(join(tmpdir(), "sideshow-shots-"));
const proc = spawn(process.execPath, [join(ROOT, "server", "index.ts")], {
  env: { ...process.env, PORT: "0", SIDESHOW_DATA: join(dataDir, "data.json") },
  stdio: ["ignore", "pipe", "inherit"],
});
const base = await new Promise((resolve, reject) => {
  let out = "";
  proc.stdout.on("data", (c) => {
    out += c;
    const m = out.match(/listening on (http:\/\/localhost:\d+)/);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error("server did not boot")), 10_000);
});

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1100, height: 900 },
  colorScheme: "dark",
  deviceScaleFactor: 2,
});
const page = await context.newPage();

// Render the chart example: load the SVG, screenshot it to a PNG, upload it as
// an asset the image card references.
const chartSvg = read("chart.svg");
await page.setContent(chartSvg, { waitUntil: "networkidle" });
const chartPng = await page.locator("svg").screenshot();
const asset = await fetch(`${base}/api/assets?filename=chart.png&kind=image`, {
  method: "POST",
  headers: { "content-type": "image/png" },
  body: chartPng,
}).then((r) => r.json());

const terminal =
  `${E}1m$ npm test -- worker${E}0m\n\n` +
  `${E}90m  worker › retry policy${E}0m\n` +
  `  ${E}32m✓${E}0m re-enqueues a failed job with backoff ${E}90m(4 ms)${E}0m\n` +
  `  ${E}32m✓${E}0m gives up after MAX_ATTEMPTS ${E}90m(2 ms)${E}0m\n` +
  `  ${E}32m✓${E}0m jitter keeps delays within [0.5x, 1.0x] ${E}90m(11 ms)${E}0m\n` +
  `  ${E}33m●${E}0m dead-letter queue ${E}33m(todo)${E}0m\n\n` +
  `${E}42;30m PASS ${E}0m  ${E}32m3 passed${E}0m, ${E}33m1 todo${E}0m  ${E}90m(0.42s)${E}0m\n\n` +
  `${E}1m$ fly deploy --strategy rolling${E}0m\n` +
  `${E}36m==>${E}0m Building image\n` +
  `${E}36m==>${E}0m Pushing  ${E}32mdone${E}0m ${E}90msha256:9c3d8e1${E}0m\n` +
  `${E}36m==>${E}0m Rolling  [${E}32m####################${E}0m] 4/4 machines\n` +
  `${E}32m✓${E}0m Deployed ${E}1mworker${E}0m v231 → ${E}1mv232${E}0m\n`;

const trace = [
  {
    label: "Read worker.ts",
    kind: "read",
    detail: "server/worker.ts — MAX_ATTEMPTS = 1; failures dropped on the floor.",
    ts: "2026-06-17T15:40:02Z",
  },
  {
    label: "Draft full-jitter backoff",
    kind: "reason",
    detail: "ceil = min(MAX_MS, BASE_MS * 2**attempt); delay = ceil * (0.5 + rand/2).",
    ts: "2026-06-17T15:40:09Z",
  },
  {
    label: "Edit worker.ts",
    kind: "edit",
    detail: "+18 −3 — added backoff(), bumped MAX_ATTEMPTS to 5, requeue on failure.",
    ts: "2026-06-17T15:40:21Z",
  },
  {
    label: "Run worker tests",
    kind: "shell",
    detail: "npm test -- worker → 3 passed, 1 todo in 0.42s",
    ts: "2026-06-17T15:40:55Z",
  },
  {
    label: "Deploy rolling",
    kind: "deploy",
    detail: "fly deploy → v231 → v232, 4/4 machines healthy.",
    ts: "2026-06-17T15:42:10Z",
  },
  {
    label: "Dropped jobs −98%",
    kind: "done",
    detail: "231/hr → 4/hr over the first hour post-deploy.",
    ts: "2026-06-17T16:42:00Z",
  },
];

// One card per kind. `file` is the screenshot name; order is the stream order.
const cards = [
  {
    file: "html",
    title: "html part — an interactive diagram you author",
    parts: [{ kind: "html", html: read("html.html") }],
  },
  {
    file: "markdown",
    title: "markdown part — prose, tables and code, rendered",
    parts: [{ kind: "markdown", markdown: read("tradeoff.md") }],
  },
  {
    file: "diff",
    title: "diff part — a patch rendered as code review",
    parts: [{ kind: "diff", patch: read("retry.patch"), layout: "unified" }],
  },
  {
    file: "terminal",
    title: "terminal part — shell output with ANSI color",
    parts: [{ kind: "terminal", text: terminal, cols: 76, title: "deploy.log" }],
  },
  {
    file: "trace",
    title: "trace part — an agent run as a step timeline",
    parts: [{ kind: "trace", steps: trace, title: "agent run" }],
  },
  {
    file: "image",
    title: "image part — an uploaded, content-addressed asset",
    parts: [
      {
        kind: "image",
        assetId: asset.id,
        alt: "Dropped jobs per hour before vs after",
        caption: "First hour after deploy: 231/hr → 4/hr.",
      },
    ],
  },
  {
    file: "mermaid",
    title: "mermaid part — a diagram from a few lines of text",
    parts: [{ kind: "mermaid", mermaid: read("loop.mmd") }],
  },
  {
    file: "combined",
    title: "markdown + diff — two parts composed in one card",
    parts: [
      { kind: "markdown", markdown: read("dlq.md") },
      { kind: "diff", patch: read("dlq.patch"), layout: "unified" },
    ],
  },
  {
    file: "issue-tree",
    title: "issue-tree part — nested sub-issues with a computed rollup",
    parts: [{ kind: "issue-tree", root: JSON.parse(read("issue-tree.json")) }],
  },
];

let session;
for (const c of cards) {
  const res = await post("/api/surfaces", {
    title: c.title,
    parts: c.parts,
    agent: "claude-opus",
    ...(session ? { session } : { sessionTitle: "Surface kinds" }),
  });
  session = session ?? res.sessionId;
}

await page.goto(`${base}/?session=${session}`, { waitUntil: "domcontentloaded" });
const stream = ".card:not(#sessionThread):not(#whatsNew)";
await page.locator(stream).first().waitFor();
await page.locator(`${stream} iframe`).first().waitFor();
await page.locator(`${stream} img`).first().waitFor();
await sleep(2500); // let iframes report height, fonts settle, highlighting paint

const shots = page.locator(stream);
const n = await shots.count();
for (let i = 0; i < cards.length && i < n; i++) {
  const path = join(OUT, `${i + 1}`.padStart(2, "0") + `-${cards[i].file}.png`);
  await shots.nth(i).screenshot({ path });
  console.log(path);
}

await context.close();
await browser.close();
proc.kill();

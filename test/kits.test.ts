import assert from "node:assert/strict";
import { test } from "node:test";
import { isKnownKit, KIT_IDS, kitAssets, kitSummaries } from "../server/kits.ts";
import { renderHtmlPage } from "../server/surfacePage.ts";
import { coerceSurfaces, validateSurfaces } from "../server/postSurfaces.ts";

// --- kitAssets ---

test("kitAssets injects a known kit's css and ignores unknown ids", () => {
  const { css, js } = kitAssets(["issues", "nope"]);
  assert.match(css, /\.tree/);
  assert.match(css, /\.badge/);
  assert.equal(js, ""); // issues is css-only
});

test("kitAssets includes the shared core exactly once across multiple kits", () => {
  const { css } = kitAssets(["issues", "slides"]);
  // .row is a CORE class — present once even with two kits requested
  assert.equal(css.match(/\.row\{/g)?.length, 1);
  assert.match(css, /\.tree/); // issues-specific
  assert.match(css, /\.deck>\.slide/); // slides-specific
});

test("kitAssets dedupes a repeated kit id", () => {
  assert.equal(kitAssets(["issues", "issues"]).css, kitAssets(["issues"]).css);
});

test("kitAssets returns nothing for empty / unknown-only / missing lists", () => {
  assert.deepEqual(kitAssets([]), { css: "", js: "" });
  assert.deepEqual(kitAssets(["bogus"]), { css: "", js: "" });
  assert.deepEqual(kitAssets(undefined), { css: "", js: "" });
});

test("only behavior kits ship js", () => {
  assert.match(kitAssets(["slides"]).js, /deck-ctl/);
  assert.equal(kitAssets(["issues"]).js, "");
});

test("slides kit grid-stacks in normal flow (measurable height), never an absolute overlay", () => {
  // A cross-fade deck must overlap its slides IN FLOW (grid-stack) so the deck
  // sizes to the tallest slide and the frame's box-watching ResizeObserver can
  // see it. An absolute overlay grows scrollHeight without growing the box, so
  // the frame goes blind and clips the deck — the exact regression this guards.
  const { css } = kitAssets(["slides"]);
  assert.match(css, /\.deck\{[^}]*display:grid/); // container grid-stacks
  assert.match(css, /\.deck>\.slide\{[^}]*grid-area:1\/1/); // children share one cell
  assert.doesNotMatch(css, /\.deck>\.slide[^}]*position:absolute/); // never out of flow
});

test("isKnownKit gates on the registry", () => {
  assert.ok(isKnownKit("issues"));
  assert.ok(!isKnownKit("issue"));
  assert.ok(!isKnownKit(42));
});

// --- renderHtmlPage ---

test("renderHtmlPage injects kit css/js only when the part opts in", () => {
  const bare = renderHtmlPage({ title: "t", html: "<p>x</p>", origin: "http://x" });
  assert.doesNotMatch(bare, /\.deck-ctl/);
  assert.doesNotMatch(bare, /querySelector\('\.deck'\)/);

  const kitted = renderHtmlPage({
    title: "t",
    html: "<div class=deck></div>",
    origin: "http://x",
    kits: ["slides"],
  });
  assert.match(kitted, /\.deck>\.slide/); // css
  assert.match(kitted, /querySelector\('\.deck'\)/); // behavior js
  // base kit + bridge are still present (kit is additive, not a replacement)
  assert.match(kitted, /window\.sendPrompt/);
});

// --- discovery ---

test("kitSummaries advertises each kit without leaking the css/js payload", () => {
  const sums = kitSummaries();
  assert.deepEqual(sums.map((k) => k.id).sort(), [...KIT_IDS].sort());
  for (const k of sums) {
    assert.ok(k.summary.length > 0 && k.classes.length > 0);
    assert.equal("css" in k, false);
    assert.equal("js" in k, false);
  }
});

// --- validation: strict (REST) rejects, loose (MCP) filters ---

test("validateSurfaces accepts an html part with known kits", async () => {
  const r = await validateSurfaces([
    { kind: "html", html: "<p>x</p>", kits: ["issues", "slides"] },
  ]);
  assert.equal(r.ok, true);
  if (r.ok)
    assert.deepEqual(r.parts[0], { kind: "html", html: "<p>x</p>", kits: ["issues", "slides"] });
});

test("validateSurfaces rejects an unknown kit id with the valid set", async () => {
  const r = await validateSurfaces([{ kind: "html", html: "<p>x</p>", kits: ["bogus"] }]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /unknown kit "bogus".*issues/);
});

test("coerceSurfaces filters unknown kits rather than dropping the part", async () => {
  const parts = await coerceSurfaces([
    { kind: "html", html: "<p>x</p>", kits: ["issues", "bogus"] },
  ]);
  assert.deepEqual(parts, [{ kind: "html", html: "<p>x</p>", kits: ["issues"] }]);
});

test("coerceSurfaces drops an all-unknown kits field entirely", async () => {
  const parts = await coerceSurfaces([{ kind: "html", html: "<p>x</p>", kits: ["nope"] }]);
  assert.deepEqual(parts, [{ kind: "html", html: "<p>x</p>" }]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { planSurfaceScreenshot } from "../workers/screenshot.ts";

test("card screenshots use stable social-card dimensions without fullPage", () => {
  const plan = planSurfaceScreenshot(
    new URL("https://board.test/s/abc123.png?card=1&w=640&theme=gruvbox&mode=dark&key=secret"),
    "abc123",
    "sideshow_mode=light",
  );

  assert.deepEqual(plan.viewport, { width: 1200, height: 630 });
  assert.deepEqual(plan.screenshotOptions, { fullPage: false });
  assert.equal(plan.target, "https://board.test/s/abc123?part=0&theme=gruvbox&mode=dark");
  assert.doesNotMatch(plan.target, /key=secret|card=1|w=640/);
});

test("non-card screenshots preserve full-page behavior and configurable width", () => {
  const plan = planSurfaceScreenshot(
    new URL("https://board.test/s/abc123.png?w=640&nocache=1"),
    "abc123",
    "sideshow_mode=dark",
  );

  assert.deepEqual(plan.viewport, { width: 640, height: 800 });
  assert.deepEqual(plan.screenshotOptions, { fullPage: true });
  assert.equal(plan.target, "https://board.test/s/abc123?part=0&mode=dark");
  assert.equal(plan.noCache, true);
});

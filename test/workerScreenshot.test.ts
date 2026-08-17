import assert from "node:assert/strict";
import { test } from "node:test";
import { matchPostScreenshot, planPostScreenshot } from "../workers/screenshot.ts";

test("post screenshot route matches GET and HEAD requests without baking in an id alphabet", () => {
  assert.equal(matchPostScreenshot("GET", "/p/4tgMLMav_WY.png"), "4tgMLMav_WY");
  assert.equal(matchPostScreenshot("GET", "/s/4tgMLMav_WY.png"), "4tgMLMav_WY"); // legacy alias
  assert.equal(matchPostScreenshot("HEAD", "/p/future.id~v2.png"), "future.id~v2");
  assert.equal(matchPostScreenshot("POST", "/p/abc123.png"), null);
  assert.equal(matchPostScreenshot("HEAD", "/p/abc123"), null);
  assert.equal(matchPostScreenshot("GET", "/p/nested/id.png"), null);
  assert.equal(matchPostScreenshot("GET", "/x/abc123.png"), null);
});

test("card screenshots use stable social-card dimensions without fullPage", () => {
  const plan = planPostScreenshot(
    new URL(
      "https://workspace.test/p/abc123.png?card=1&w=640&theme=gruvbox&mode=dark&v=7&key=secret",
    ),
    "abc123",
    "sideshow_mode=light",
  );

  assert.deepEqual(plan.viewport, { width: 1200, height: 630 });
  assert.deepEqual(plan.screenshotOptions, { fullPage: false });
  assert.equal(plan.target, "https://workspace.test/p/abc123?part=0&ver=7&theme=gruvbox&mode=dark");
  assert.doesNotMatch(plan.target, /key=secret|card=1|w=640|(?:^|[?&])v=/);
});

test("non-card screenshots preserve full-page behavior and configurable width", () => {
  const plan = planPostScreenshot(
    new URL("https://workspace.test/s/abc123.png?w=640&nocache=1"), // legacy inbound shape
    "abc123",
    "sideshow_mode=dark",
  );

  assert.deepEqual(plan.viewport, { width: 640, height: 800 });
  assert.deepEqual(plan.screenshotOptions, { fullPage: true });
  assert.equal(plan.target, "https://workspace.test/p/abc123?part=0&mode=dark");
  assert.equal(plan.noCache, true);
});

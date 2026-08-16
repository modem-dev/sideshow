// The host-side policy for messages sandboxed surfaces post (server/bridgePolicy.ts).
// Both hosts — the live viewer and the session export's shell — depend on these
// decisions being right: the frame is untrusted, so it can ask to open any URL
// and report any height.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampFrameHeight,
  EXTERNAL_LINK_PROTOCOLS,
  externalLinkHref,
  OPEN_LINK_PROMPT,
} from "../server/bridgePolicy.ts";
import { MAX_FRAME_H, MIN_FRAME_H } from "../server/types.ts";

test("externalLinkHref passes http(s) through, normalized", () => {
  assert.equal(externalLinkHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(externalLinkHref("http://example.com"), "http://example.com/");
  // The NORMALIZED href is what callers open, so validation and navigation can't
  // diverge: uppercase scheme and host fold, and the parser resolves the path.
  assert.equal(externalLinkHref("HTTPS://Example.COM/x/../y"), "https://example.com/y");
});

test("externalLinkHref rejects every scheme outside the allowlist", () => {
  // A contained script can post these directly — the in-frame click handler's
  // filtering is not a boundary, this is.
  for (const hostile of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "blob:https://example.com/abc",
    "vbscript:msgbox(1)",
    "about:blank",
  ]) {
    assert.equal(externalLinkHref(hostile), null, hostile);
  }
});

test("externalLinkHref rejects unparseable and non-string input", () => {
  for (const junk of ["", "not a url", "///", null, undefined, {}, 42, []]) {
    assert.equal(externalLinkHref(junk), null, JSON.stringify(junk));
  }
});

test("the allowlist and prompt are the values both hosts share", () => {
  assert.deepEqual([...EXTERNAL_LINK_PROTOCOLS], ["http:", "https:"]);
  // The prompt must end in a separator so a host can append the href directly;
  // both hosts do exactly that.
  assert.match(OPEN_LINK_PROMPT, /\n\n$/);
});

test("clampFrameHeight bounds a reported height", () => {
  assert.equal(clampFrameHeight(200), 200);
  assert.equal(clampFrameHeight(MIN_FRAME_H - 1), MIN_FRAME_H, "below min floors");
  assert.equal(clampFrameHeight(MAX_FRAME_H + 5000), MAX_FRAME_H, "runaway growth is capped");
  assert.equal(clampFrameHeight(-9999), MIN_FRAME_H, "negative floors");
});

test("clampFrameHeight floors garbage to the minimum, never NaN", () => {
  // A NaN would reach the DOM as "NaNpx" — an invalid length that leaves the
  // frame unsized. Math.max(NaN, MIN) is NaN, so the guard is load-bearing.
  for (const junk of [undefined, null, "abc", {}, NaN, []]) {
    const h = clampFrameHeight(junk);
    assert.ok(Number.isFinite(h), `${JSON.stringify(junk)} → finite`);
    assert.equal(h, MIN_FRAME_H);
  }
  // A numeric string still measures — the bridge posts numbers, but a host that
  // forwards the raw value shouldn't collapse a real height to the minimum.
  assert.equal(clampFrameHeight("300"), 300);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotes } from "../viewer/src/notes.ts";

// Release notes come from the GitHub release at runtime and render in the trusted
// viewer chrome. An external link must open with BOTH noopener (no window.opener
// reverse-tabnabbing) and noreferrer (the viewer URL — which can carry the `?key=`
// deploy token — never leaks via Referer to the destination site).
test("renderNotes external links carry rel=noopener noreferrer", () => {
  const html = renderNotes("See [the docs](https://example.com/x) for details.");
  assert.match(
    html,
    /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">the docs<\/a>/,
  );
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { postToMarkdown, stripAnsi, unifiedDiff } from "../server/postMarkdown.ts";
import type { MarkdownablePost } from "../server/postMarkdown.ts";
import type { Surface } from "../server/types.ts";

const OPTS = { postUrl: "https://ex.test/p/abc", assetBase: "https://ex.test" };

function post(surfaces: Surface[], extra: Partial<MarkdownablePost> = {}): MarkdownablePost {
  return { title: "Retry backoff", surfaces, ...extra };
}

// The only honest oracle for a patch is applying it. Asserting on hunk text
// misses exactly the class of bug that matters — a patch that reads fine and is
// rejected by `git apply`, or applies to content that isn't the "after" side.
function assertApplies(before: string, after: string): void {
  const patch = unifiedDiff("f.txt", before, after);
  assert.notEqual(patch, "", "differing content must produce a patch");
  const dir = mkdtempSync(join(tmpdir(), "sideshow-diff-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    writeFileSync(join(dir, "f.txt"), before);
    writeFileSync(join(dir, "p.diff"), patch);
    execFileSync("git", ["apply", "p.diff"], { cwd: dir, stdio: "pipe" });
    assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), after, `patch applied wrong:\n${patch}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("heads the document with the title, permalink, version and an absolute stamp", () => {
  const md = postToMarkdown(
    post([{ kind: "markdown", markdown: "prose" }], {
      version: 3,
      updatedAt: "2026-08-17T21:20:06.819Z",
    }),
    OPTS,
  );
  assert.equal(
    md,
    "## Retry backoff\n\n[View in sideshow](https://ex.test/p/abc) · v3 · 2026-08-17 21:20 UTC\n\nprose\n",
  );
});

test("omits the version on v1 and the link when there is no url", () => {
  const md = postToMarkdown(post([{ kind: "markdown", markdown: "prose" }], { version: 1 }));
  assert.equal(md, "## Retry backoff\n\nprose\n");
});

test("flattens each surface kind to its honest markdown form", () => {
  const md = postToMarkdown(
    post([
      { kind: "markdown", markdown: "  prose  " },
      { kind: "code", code: "const x = 1;", language: "ts", title: "x.ts" },
      { kind: "diff", patch: "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b" },
      { kind: "terminal", text: "\u001b[32mok\u001b[0m" },
      { kind: "json", data: { a: [1, null] } },
      { kind: "mermaid", mermaid: "flowchart TD\n  A --> B" },
      { kind: "image", assetId: "sha", alt: "a shot", caption: "after" },
    ]),
    OPTS,
  );
  assert.equal(
    md,
    [
      "## Retry backoff",
      "[View in sideshow](https://ex.test/p/abc)",
      "prose",
      "**`x.ts`**\n\n```ts\nconst x = 1;\n```",
      "```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n```",
      "```console\nok\n```",
      '```json\n{\n  "a": [\n    1,\n    null\n  ]\n}\n```',
      "```mermaid\nflowchart TD\n  A --> B\n```",
      "![a shot](https://ex.test/a/sha)\n\n_after_\n",
    ].join("\n\n"),
  );
});

test("html has no markdown form, so it links back to the surface", () => {
  const md = postToMarkdown(post([{ kind: "html", html: "<b onclick='x()'>hi</b>" }]), OPTS);
  assert.match(md, /\[Html surface — open in sideshow\]\(https:\/\/ex\.test\/p\/abc\?part=0\)/);
  // Never dump markup into a document meant for pasting elsewhere.
  assert.doesNotMatch(md, /onclick/);
});

test("a kind this build doesn't know still links rather than vanishing", () => {
  const md = postToMarkdown(post([{ kind: "hologram" } as unknown as Surface]), OPTS);
  assert.match(md, /\[hologram surface — open in sideshow\]\(https:\/\/ex\.test\/p\/abc\?part=0\)/);
});

test("an excerpt keeps the line numbers the viewer shows", () => {
  const md = postToMarkdown(
    post([{ kind: "code", code: "a\nb\nc", language: "ts", title: "x.ts", lineStart: 80 }]),
  );
  assert.match(md, /\*\*`x\.ts`\*\* \(lines 80–82\)/);
});

test("fences grow past backticks in the content", () => {
  const md = postToMarkdown(post([{ kind: "code", code: "a\n```\nb", language: "text" }]));
  assert.match(md, /````text\na\n```\nb\n````/);
});

test("an image without an absolute asset base degrades to its alt text", () => {
  // A relative /a/:id link is broken the moment the markdown is pasted elsewhere.
  const md = postToMarkdown(post([{ kind: "image", assetId: "sha", alt: "a shot" }]));
  assert.equal(md, "## Retry backoff\n\n_a shot_\n");
});

test("a diff sent as before/after files becomes a real unified patch", () => {
  const md = postToMarkdown(
    post([
      {
        kind: "diff",
        files: [{ filename: "x.ts", before: "one\ntwo\nthree\n", after: "one\n2\nthree\n" }],
      },
    ]),
  );
  assert.equal(
    md,
    [
      "## Retry backoff",
      "",
      "```diff",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+2",
      " three",
      "```",
      "",
    ].join("\n"),
  );
});

test("unifiedDiff: no hunks for identical files, additions at the end", () => {
  assert.equal(unifiedDiff("x.ts", "a\n", "a\n"), "");
  assert.equal(
    unifiedDiff("x.ts", "a\n", "a\nb\n"),
    "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n a\n+b\n",
  );
});

test("unifiedDiff: separate edits get separate hunks with context", () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 2", "LINE 2").replace("line 25", "LINE 25");
  const patch = unifiedDiff("x.ts", before, after);
  assert.equal(patch.match(/^@@/gm)?.length, 2);
  assert.match(patch, /-line 2\n\+LINE 2/);
  assert.match(patch, /-line 25\n\+LINE 25/);
  // Context is bounded — an unchanged middle never lands in a hunk.
  assert.doesNotMatch(patch, /line 15/);
});

test("unifiedDiff: a wholesale rewrite stays bounded instead of building a matrix", () => {
  const before = Array.from({ length: 4000 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 4000 }, (_, i) => `new ${i}`).join("\n");
  const patch = unifiedDiff("big.ts", before, after);
  assert.match(patch, /^-old 0$/m);
  assert.match(patch, /^\+new 3999$/m);
});

test("stripAnsi drops SGR, cursor moves and OSC sequences", () => {
  assert.equal(stripAnsi("\u001b[1;32mok\u001b[0m\u001b[2J"), "ok");
  assert.equal(stripAnsi("\u001b]0;title\u0007done"), "done");
});

// Every case below is one `git apply` reproduced by hand from a real failure:
// without the `\ No newline at end of file` marker (and with an empty file
// modelled as one blank line) each of these produced a patch git rejects, or
// worse, one that applies and yields content the agent never sent.
test("patches apply cleanly regardless of the end-of-file newline", () => {
  assertApplies("a\nb\nc\n", "a\nB\nc\n"); // the easy case
  assertApplies("a\nb\nc", "a\nB\nc"); // neither side ends with a newline
  assertApplies("a\nb\nc\n", "a\nB\nc"); // the trailing newline is dropped
  assertApplies("a\nb\nc", "a\nB\nc\n"); // ...and added
  assertApplies("a\nb\nc", "a\nb\nC"); // the edit lands on the last line
  assertApplies("", "foo\n"); // an empty file gains content
  assertApplies("foo\n", ""); // ...and loses all of it
  assertApplies("", "foo"); // empty in, no trailing newline out
  assertApplies("one\n", "one\ntwo\nthree\n"); // pure append
});

test("a trailing-newline-only change is a real diff, not an empty one", () => {
  // The lines are identical; only the end-of-file newline moves. Treating the
  // last line as unchanged made this vanish into the link fallback.
  assertApplies("a\nb\nc", "a\nb\nc\n");
  const md = postToMarkdown(
    post([{ kind: "diff", files: [{ filename: "x.ts", before: "a\nb\nc", after: "a\nb\nc\n" }] }]),
    OPTS,
  );
  assert.match(md, /```diff/);
  assert.match(md, /\\ No newline at end of file/);
  assert.doesNotMatch(md, /open in sideshow/);
});

test("an excerpt ending in a newline is not counted one line too long", () => {
  const heading = (code: string) =>
    postToMarkdown(post([{ kind: "code", code, language: "ts", lineStart: 10 }]));
  assert.match(heading("a\nb\nc\n"), /\(lines 10–12\)/);
  assert.match(heading("a\nb\nc"), /\(lines 10–12\)/);
  assert.match(heading(""), /\(lines 10–10\)/);
});

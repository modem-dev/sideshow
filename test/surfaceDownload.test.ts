import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { surfaceDownload, surfaceDownloadName } from "../server/surfaceDownload.ts";
import type { Surface } from "../server/types.ts";

const TITLE = "Retry backoff";

function inline(surface: Surface, index = 0, title: string | undefined = TITLE) {
  const download = surfaceDownload(surface, index, title);
  assert.ok(download, "expected a download");
  assert.equal(download.via, "inline", "expected inline bytes, not an asset");
  return download;
}

test("names a file from the kind's extension and the post title", () => {
  assert.equal(surfaceDownloadName({ kind: "mermaid" }, 0, TITLE), "retry-backoff.mmd");
  assert.equal(surfaceDownloadName({ kind: "markdown" }, 0, TITLE), "retry-backoff.md");
  assert.equal(surfaceDownloadName({ kind: "diff" }, 0, TITLE), "retry-backoff.patch");
  assert.equal(surfaceDownloadName({ kind: "terminal" }, 0, TITLE), "retry-backoff.txt");
  assert.equal(surfaceDownloadName({ kind: "json" }, 0, TITLE), "retry-backoff.json");
  assert.equal(surfaceDownloadName({ kind: "html" }, 0, TITLE), "retry-backoff.html");
});

test("numbers every surface after the first, so a multi-surface post can't collide", () => {
  assert.equal(surfaceDownloadName({ kind: "mermaid" }, 0, TITLE), "retry-backoff.mmd");
  assert.equal(surfaceDownloadName({ kind: "mermaid" }, 1, TITLE), "retry-backoff-2.mmd");
  assert.equal(surfaceDownloadName({ kind: "markdown" }, 2, TITLE), "retry-backoff-3.md");
});

test("falls back to a usable stem for a title that slugs to nothing", () => {
  assert.equal(surfaceDownloadName({ kind: "markdown" }, 0, "!!! ???"), "post.md");
  assert.equal(surfaceDownloadName({ kind: "markdown" }, 0, ""), "post.md");
  assert.equal(surfaceDownloadName({ kind: "markdown" }, 0, undefined), "post.md");
});

test("caps a rambling title instead of producing a name the OS would refuse", () => {
  const name = surfaceDownloadName({ kind: "markdown" }, 0, "word ".repeat(40));
  assert.ok(name.length <= 52, `name too long: ${name}`);
  assert.ok(!name.includes("-."), `stem must not end in a dash: ${name}`);
});

test("a code surface keeps the filename its agent gave it", () => {
  assert.equal(
    surfaceDownloadName({ kind: "code", title: "sqlStore.ts", language: "ts" }, 0, TITLE),
    "sqlStore.ts",
  );
});

test("a code surface with a prose title falls back to the language's extension", () => {
  assert.equal(
    surfaceDownloadName(
      { kind: "code", title: "The parser, annotated", language: "python" },
      0,
      TITLE,
    ),
    "retry-backoff.py",
  );
  assert.equal(
    surfaceDownloadName({ kind: "code", language: "rust" }, 1, TITLE),
    "retry-backoff-2.rs",
  );
  // An unknown language id is used as-is (ts, js, go all name their extension);
  // a missing or nonsense one degrades to plain text rather than a broken name.
  assert.equal(
    surfaceDownloadName({ kind: "code", language: "zig" }, 0, TITLE),
    "retry-backoff.zig",
  );
  assert.equal(surfaceDownloadName({ kind: "code" }, 0, TITLE), "retry-backoff.txt");
  assert.equal(
    surfaceDownloadName({ kind: "code", language: "c++ (old)" }, 0, TITLE),
    "retry-backoff.txt",
  );
});

test("downloads a mermaid surface as its source, not as a rendering", () => {
  const download = inline({ kind: "mermaid", mermaid: "graph TD;\n  a-->b;" });
  assert.equal(download.filename, "retry-backoff.mmd");
  assert.equal(download.body, "graph TD;\n  a-->b;");
  assert.match(download.contentType, /^text\/plain/);
});

test("downloads markdown and terminal text verbatim", () => {
  assert.equal(inline({ kind: "markdown", markdown: "# hi\n" }).body, "# hi\n");
  // ANSI escapes survive: they ARE the original output, and a terminal replays
  // them. (postMarkdown strips them because a markdown fence cannot render them.)
  const ansi = "\u001b[31mred\u001b[0m\n";
  assert.equal(inline({ kind: "terminal", text: ansi }).body, ansi);
});

test("serializes a json surface as indented JSON", () => {
  const download = inline({ kind: "json", data: { a: [1, 2] } });
  assert.equal(download.body, '{\n  "a": [\n    1,\n    2\n  ]\n}');
  assert.match(download.contentType, /^application\/json/);
});

test("serves html as an inert octet-stream, never as a live document type", () => {
  const download = inline({ kind: "html", html: "<b>hi</b>" });
  assert.equal(download.contentType, "application/octet-stream");
  assert.equal(download.body, "<b>hi</b>");
});

test("a diff surface downloads a patch git apply accepts", () => {
  const surface: Surface = {
    kind: "diff",
    files: [{ filename: "f.txt", before: "a\nb\n", after: "a\nc\n" }],
  };
  const patch = inline(surface).body;
  const dir = mkdtempSync(join(tmpdir(), "sideshow-download-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    writeFileSync(join(dir, "f.txt"), "a\nb\n");
    writeFileSync(join(dir, "p.patch"), patch);
    execFileSync("git", ["apply", "p.patch"], { cwd: dir, stdio: "pipe" });
    assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "a\nc\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a diff surface prefers the patch it was published with", () => {
  const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
  assert.equal(inline({ kind: "diff", patch }).body, patch);
});

test("asset-backed surfaces defer to the stored blob instead of re-encoding it", () => {
  const image = surfaceDownload({ kind: "image", assetId: "asset1" }, 0, TITLE);
  assert.deepEqual(image, { via: "asset", filename: "retry-backoff.png", assetId: "asset1" });
  const trace = surfaceDownload({ kind: "trace", assetId: "asset2", steps: [] }, 0, TITLE);
  assert.equal(trace?.via, "asset");
});

test("an inline trace downloads its steps as the JSON they are", () => {
  const download = inline({ kind: "trace", steps: [{ label: "ran tests" }] }, 0);
  assert.equal(download.filename, "retry-backoff.json");
  assert.equal(download.body, '[\n  {\n    "label": "ran tests"\n  }\n]');
});

test("returns null rather than serving an empty file", () => {
  assert.equal(surfaceDownload({ kind: "markdown", markdown: "" }, 0, TITLE), null);
  assert.equal(surfaceDownload({ kind: "mermaid", mermaid: "" }, 0, TITLE), null);
  assert.equal(surfaceDownload({ kind: "diff" }, 0, TITLE), null);
  assert.equal(surfaceDownload({ kind: "diff", files: [] }, 0, TITLE), null);
  assert.equal(surfaceDownload({ kind: "trace" }, 0, TITLE), null);
  assert.equal(surfaceDownload({ kind: "image", assetId: "" }, 0, TITLE), null);
  // Forward compatibility: a kind this build doesn't know downloads nothing
  // rather than throwing the request.
  assert.equal(surfaceDownload({ kind: "hologram" } as unknown as Surface, 0, TITLE), null);
});

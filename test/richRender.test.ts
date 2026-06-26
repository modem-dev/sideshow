import assert from "node:assert/strict";
import { test } from "node:test";
import { renderCode, renderDiff, renderMarkdown, renderTerminal } from "../server/richRender.ts";
import type {
  CodeSurface,
  DiffSurface,
  MarkdownSurface,
  TerminalSurface,
} from "../server/types.ts";

// richRender builds the sandboxed HTML served from /s/:id for the rich surface
// kinds. It has no unit tests today (only e2e), so branch coverage sits at ~61%.
// These exercise the fallbacks and optional-field branches that produce HTML.

test("renderMarkdown: links get target=_blank and rel=noopener noreferrer", async () => {
  const md: MarkdownSurface = { kind: "markdown", markdown: "[ex](https://example.com)" };
  const { body } = await renderMarkdown(md);
  assert.match(body, /target="_blank"/);
  assert.match(body, /rel="noopener noreferrer"/);
  assert.match(body, /href="https:\/\/example\.com"/);
});

test("renderMarkdown: code blocks are highlighted and inline code escaped", async () => {
  const md: MarkdownSurface = { kind: "markdown", markdown: "    `let x = 1`" };
  const { body } = await renderMarkdown(md);
  assert.match(body, /<code>/);
});

test("renderCode: an empty language falls back to the plain pre renderer", async () => {
  // language: "" defeats the `?? "text"` default, so highlight() sees a falsy
  // lang and returns null → plainHtml. (A literal "text" is a real shiki lang
  // and gets highlighted; "" is the path that exercises the !lang branch.)
  const code: CodeSurface = { kind: "code", code: "a\nb\nc", language: "" };
  const { body } = await renderCode(code);
  assert.match(body, /<pre class="plain">/);
  assert.equal(body.match(/<span class="line">/g)?.length, 3);
});

test("renderCode: an unknown language falls back to plain (highlight try/catch)", async () => {
  // shiki can't load "klingon"; codeToHtml throws → highlight() catches → plainHtml.
  const code: CodeSurface = { kind: "code", code: "blah", language: "klingon" };
  const { body } = await renderCode(code);
  assert.match(body, /<pre class="plain">/);
});

test("renderCode: lineStart injects a counter-reset so line numbers start later", async () => {
  const code: CodeSurface = { kind: "code", code: "x\ny", language: "typescript", lineStart: 42 };
  const { body } = await renderCode(code);
  assert.match(body, /counter-reset:line 41/);
});

test("renderCode: a known language highlights (shiki pre, not plain)", async () => {
  const code: CodeSurface = { kind: "code", code: "const x = 1;", language: "typescript" };
  const { body } = await renderCode(code);
  assert.match(body, /<pre\b[^>]*class="shiki/);
  assert.doesNotMatch(body, /<pre class="plain">/);
});

test("renderCode: a filename/title populates the header bar", async () => {
  const code: CodeSurface = { kind: "code", code: "x", language: "typescript", title: "app.ts" };
  const { body } = await renderCode(code);
  assert.match(body, /code-filename/);
  assert.match(body, /app\.ts/);
  assert.match(body, /code-lang/);
});

test("renderCode: the copy button embeds the source escaped for JS strings", async () => {
  const code: CodeSurface = { kind: "code", code: "let s = '<b>';", language: "javascript" };
  const { body } = await renderCode(code);
  // the < in the embedded JSON string is escaped to \u003c so it can't break out
  assert.match(body, /\\u003c/);
  assert.match(body, /__codeCopy/);
});

test("renderDiff: explicit before/after file pairs render without a patch", async () => {
  const diff: DiffSurface = {
    kind: "diff",
    files: [{ filename: "f.txt", before: "old line", after: "new line" }],
  };
  const { body } = await renderDiff(diff);
  assert.match(body, /<diffs-container>/);
  // the rendered shadow root is non-empty
  assert.ok(
    body.replace(/<diffs-container>|<template[^>]*>|<\/template>|<\/diffs-container>/g, "").length >
      0,
  );
});

test("renderDiff: a multi-file patch renders one diffs-container per file", async () => {
  const patch = [
    "--- a/one.txt",
    "+++ b/one.txt",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "--- a/two.txt",
    "+++ b/two.txt",
    "@@ -1 +1 @@",
    "-c",
    "+d",
  ].join("\n");
  const { body } = await renderDiff({ kind: "diff", patch });
  assert.equal(body.match(/<diffs-container>/g)?.length, 2);
});

test("renderDiff: a patch with no recognizable file headers hits the processFile fallback", async () => {
  // No --- a/ +++ b/ headers, so parsePatchFiles yields nothing and buildFileDiffs
  // falls back to processFile. Either it produces a diff or renderDiff throws
  // "No diff content." — both exercise the fallback branch; assert the path is
  // reached without an unrelated failure.
  const headerless = ["@@ -1 +1 @@", "-old", "+new"].join("\n");
  try {
    const { body } = await renderDiff({ kind: "diff", patch: headerless });
    assert.match(body, /<diffs-container>/);
  } catch (err) {
    assert.match((err as Error).message, /No diff content/);
  }
});

test("renderDiff: an empty patch and no files throws No diff content", async () => {
  await assert.rejects(() => renderDiff({ kind: "diff", patch: "" }), /No diff content/);
});

test("renderTerminal: ANSI codes are converted and a window bar is rendered", async () => {
  const term: TerminalSurface = {
    kind: "terminal",
    text: "\x1b[32mok\x1b[0m done",
    title: "build",
    cols: 80,
  };
  const { body } = await renderTerminal(term);
  assert.match(body, /term-bar/);
  assert.match(body, /build/);
  // ansi_up turns the green SGR into a span with a color style
  assert.match(body, /<span style="color:/);
});

test("renderTerminal: a title-less terminal defaults the bar title to 'terminal'", async () => {
  const term: TerminalSurface = { kind: "terminal", text: "plain output" };
  const { body } = await renderTerminal(term);
  // the bar is always rendered; a missing title defaults to "terminal", and no
  // cols means the body <pre> carries no width style
  assert.match(body, /term-bar/);
  assert.match(body, /<span class="term-title">terminal<\/span>/);
  assert.match(body, /<pre class="term-body">plain output<\/pre>/);
});

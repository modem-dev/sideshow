// Pure parser tests — run on plain Node (no opentui). `node --test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEntities, parse, type STMLElement } from "../src/parse.ts";

const el = (n: unknown) => n as STMLElement;

test("nests elements and text", () => {
  const { nodes, errors } = parse("<box><text>hi</text></box>");
  assert.equal(errors.length, 0);
  assert.equal(nodes.length, 1);
  const box = el(nodes[0]);
  assert.equal(box.tag, "box");
  const text = el(box.children[0]);
  assert.equal(text.tag, "text");
  assert.deepEqual(text.children[0], { type: "text", value: "hi" });
});

test("parses quoted, unquoted, and boolean attributes", () => {
  const { nodes } = parse(`<box border title="Cache layout" width=40 bg='#222'>x</box>`);
  const box = el(nodes[0]);
  assert.equal(box.attrs.border, "");
  assert.equal(box.attrs.title, "Cache layout");
  assert.equal(box.attrs.width, "40");
  assert.equal(box.attrs.bg, "#222");
});

test("lowercases tag and attribute names", () => {
  const { nodes } = parse(`<Box Title="X"></Box>`);
  assert.equal(el(nodes[0]).tag, "box");
  assert.equal(el(nodes[0]).attrs.title, "X");
});

test("handles void and self-closing tags", () => {
  const { nodes, errors } = parse("<hr/><br><spacer/>");
  assert.equal(errors.length, 0);
  assert.deepEqual(
    nodes.map((n) => el(n).tag),
    ["hr", "br", "spacer"],
  );
  assert.equal(el(nodes[0]).children.length, 0);
});

test("raw tags preserve inner text verbatim, no nested parsing", () => {
  const { nodes } = parse("<code>if (a < b) { return <x> }</code>");
  const code = el(nodes[0]);
  assert.equal(code.tag, "code");
  assert.equal(code.children.length, 1);
  assert.equal(el(code.children[0] as unknown).type ?? "text", "text");
  assert.equal((code.children[0] as { value: string }).value, "if (a < b) { return <x> }");
});

test("decodes entities in attributes; text stays verbatim (decoded at render)", () => {
  assert.equal(decodeEntities("a &lt;b&gt; &amp; &#65; &#x42;"), "a <b> & A B");
  const { nodes } = parse(`<text title="a &amp; b">x &lt; y</text>`);
  // Attributes are decoded by the parser (consumed directly)...
  assert.equal(el(nodes[0]).attrs.title, "a & b");
  // ...but text keeps entities; the renderer calls decodeEntities on it.
  const raw = (el(nodes[0]).children[0] as { value: string }).value;
  assert.equal(raw, "x &lt; y");
  assert.equal(decodeEntities(raw), "x < y");
});

test("ignores comments", () => {
  const { nodes } = parse("<box><!-- hidden -->shown</box>");
  const box = el(nodes[0]);
  assert.equal(box.children.length, 1);
  assert.equal((box.children[0] as { value: string }).value, "shown");
});

test("tolerates mismatched and stray closing tags", () => {
  const r1 = parse("<box><row>x</box>");
  assert.equal(el(r1.nodes[0]).tag, "box");
  assert.ok(r1.errors.length > 0);

  const r2 = parse("</nope>text");
  assert.ok(r2.errors.some((e) => e.includes("stray")));
  assert.equal((r2.nodes[0] as { value: string }).value, "text");
});

test("reports unclosed tags but still returns a tree", () => {
  const { nodes, errors } = parse("<box>content");
  assert.equal(el(nodes[0]).tag, "box");
  assert.equal((el(nodes[0]).children[0] as { value: string }).value, "content");
  assert.ok(errors.some((e) => e.includes("unclosed")));
});

test("treats a bare '<' as text", () => {
  const { nodes } = parse("a < b and 3<4");
  assert.equal(nodes.length, 1);
  assert.equal((nodes[0] as { value: string }).value, "a < b and 3<4");
});

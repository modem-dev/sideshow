import assert from "node:assert/strict";
import { test } from "node:test";
import { findHardcodedColors, lintSurfaces } from "../server/surfaceLint.ts";
import type { Surface } from "../server/types.ts";

const html = (s: string): Surface => ({ kind: "html", html: s });

test("flags a hardcoded background + text color in an inline style", () => {
  const hits = findHardcodedColors('<div style="background:#ffffff;color:#57606a">x</div>');
  assert.deepEqual(hits, ["background: #ffffff", "color: #57606a"]);
});

test("flags rgb()/rgba()/hsl() and the named scheme-breakers", () => {
  assert.ok(findHardcodedColors('<p style="color:rgb(20,20,20)">x</p>').length);
  assert.ok(findHardcodedColors('<p style="background:rgba(0,0,0,.5)">x</p>').length);
  assert.ok(findHardcodedColors('<p style="background:hsl(0,0%,100%)">x</p>').length);
  assert.ok(findHardcodedColors('<p style="background:white">x</p>').length);
  assert.ok(findHardcodedColors('<p style="color:black">x</p>').length);
});

test("flags colors in a <style> block too", () => {
  const hits = findHardcodedColors("<style>.box{background:#0d1117}</style><div class=box></div>");
  assert.deepEqual(hits, ["background: #0d1117"]);
});

test("does NOT flag theme-token values (var(--color-*))", () => {
  assert.deepEqual(
    findHardcodedColors(
      '<div style="background:var(--color-background-primary);color:var(--color-text-primary)">x</div>',
    ),
    [],
  );
});

test("does NOT flag a var() with a hardcoded fallback (the literal is last-resort)", () => {
  assert.deepEqual(
    findHardcodedColors('<div style="color:var(--color-text-primary, #111)">x</div>'),
    [],
  );
});

test("ignores non-scheme properties (SVG fill/stroke, borders)", () => {
  // fill/stroke carry literal colors constantly without breaking adaptiveness.
  assert.deepEqual(findHardcodedColors('<rect fill="#fff" stroke="#000" />'), []);
  assert.deepEqual(findHardcodedColors('<div style="border-color:#ccc">x</div>'), []);
});

test("caps the reported declarations at 4", () => {
  const many = Array.from({ length: 10 }, (_, i) => `color:#${i}${i}${i}`).join(";");
  assert.equal(findHardcodedColors(`<div style="${many}">x</div>`).length, 4);
});

test("lintSurfaces only warns on html surfaces, with a 1-based surface label", () => {
  const parts: Surface[] = [
    { kind: "markdown", markdown: "color:#fff is just text here" },
    html('<div style="background:#fff">x</div>'),
  ];
  const warnings = lintSurfaces(parts);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^surface 2 hardcodes colors \(background: #fff\)/);
  assert.match(warnings[0], /--color-\* theme tokens/);
});

test("lintSurfaces says just 'surface' when there is only one", () => {
  const warnings = lintSurfaces([html('<div style="background:#fff">x</div>')]);
  assert.match(warnings[0], /^surface hardcodes colors/);
});

test("lintSurfaces is silent for a fully token-driven surface", () => {
  assert.deepEqual(
    lintSurfaces([html('<div style="background:var(--color-background-primary)">ok</div>')]),
    [],
  );
});

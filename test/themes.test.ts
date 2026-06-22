import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_THEME_ID,
  type Palette,
  THEMES,
  themeById,
  themeOptions,
  tokenThemeCss,
  viewerThemeCss,
} from "../server/themes.ts";

// The flat keys every Palette must define, plus the semantic accents which each
// carry bg/text/border. A theme added with a missing key would silently emit a
// `var(--…)` that resolves to nothing, so pin the full shape here.
const FLAT_KEYS: (keyof Palette)[] = [
  "bg",
  "panel",
  "surface",
  "text",
  "muted",
  "faint",
  "border",
  "border2",
  "hover",
];
const ACCENT_KEYS = ["info", "success", "warning", "danger"] as const;

function assertPalette(p: Palette, where: string) {
  for (const k of FLAT_KEYS) {
    assert.equal(typeof p[k], "string", `${where}.${k} should be a string`);
    assert.ok((p[k] as string).length > 0, `${where}.${k} should be non-empty`);
  }
  for (const a of ACCENT_KEYS) {
    for (const sub of ["bg", "text", "border"] as const) {
      assert.equal(typeof p[a][sub], "string", `${where}.${a}.${sub} should be a string`);
      assert.ok(p[a][sub].length > 0, `${where}.${a}.${sub} should be non-empty`);
    }
  }
}

test("every registered theme has a complete light and dark palette", () => {
  assert.ok(THEMES.length > 0);
  const ids = new Set<string>();
  for (const t of THEMES) {
    assert.ok(t.id, "theme needs an id");
    assert.ok(!ids.has(t.id), `duplicate theme id: ${t.id}`);
    ids.add(t.id);
    assert.ok(t.label, `${t.id} needs a label`);
    assert.ok(t.shiki.light && t.shiki.dark, `${t.id} needs both shiki themes`);
    assertPalette(t.light, `${t.id}.light`);
    assertPalette(t.dark, `${t.id}.dark`);
  }
});

test("the default theme id resolves to a registered theme", () => {
  assert.ok(THEMES.some((t) => t.id === DEFAULT_THEME_ID));
});

test("themeById falls back to the default for null, undefined, and unknown ids", () => {
  for (const bad of [null, undefined, "", "nonexistent"]) {
    assert.equal(themeById(bad).id, DEFAULT_THEME_ID);
  }
  // a known id round-trips
  assert.equal(themeById("gruvbox").id, "gruvbox");
});

test("themeOptions lists every theme as an id/label pair", () => {
  const opts = themeOptions();
  assert.equal(opts.length, THEMES.length);
  assert.deepEqual(opts.map((o) => o.id).sort(), THEMES.map((t) => t.id).sort());
  for (const o of opts) assert.ok(o.label.length > 0);
});

test("viewerThemeCss emits chrome vars with a dark-scheme override for each theme", () => {
  for (const t of THEMES) {
    const css = viewerThemeCss(t);
    assert.ok(css.includes(":root{"), `${t.id}: missing :root block`);
    assert.ok(css.includes("--bg:"), `${t.id}: missing --bg`);
    assert.ok(css.includes("--accent:"), `${t.id}: missing --accent`);
    // the terminal vars (scheme-independent) and the dark media query both ride along
    assert.ok(css.includes("--term-bg:"), `${t.id}: missing terminal vars`);
    assert.ok(
      css.includes("@media (prefers-color-scheme: dark)"),
      `${t.id}: missing dark-scheme override`,
    );
  }
});

test("tokenThemeCss emits the agent-facing --color-* tokens for each theme", () => {
  for (const t of THEMES) {
    const css = tokenThemeCss(t);
    assert.ok(css.includes("--color-text-primary:"), `${t.id}: missing text token`);
    assert.ok(css.includes("--color-background-primary:"), `${t.id}: missing bg token`);
    assert.ok(css.includes("--color-border-info:"), `${t.id}: missing border token`);
    assert.ok(
      css.includes("@media (prefers-color-scheme: dark)"),
      `${t.id}: tokens need a dark-scheme override`,
    );
  }
});

// A pinned mode emits a single flat :root with that scheme's values and NO
// media query, so a surface iframe renders the mode the chrome resolved rather
// than re-deriving it from the OS across the frame boundary.
test("a pinned mode forces the scheme with no prefers-color-scheme media query", () => {
  const gh = themeById("github");

  const dark = tokenThemeCss(gh, "dark");
  assert.ok(!dark.includes("@media"), "dark mode must not emit a media query");
  // github dark surface is the html-part background-primary token
  assert.ok(dark.includes(`--color-background-primary: ${gh.dark.surface}`), "dark bg token");
  assert.ok(!dark.includes(gh.light.surface), "dark output must not carry light values");

  const light = tokenThemeCss(gh, "light");
  assert.ok(!light.includes("@media"), "light mode must not emit a media query");
  assert.ok(light.includes(`--color-background-primary: ${gh.light.surface}`), "light bg token");

  // viewerThemeCss pins the same way (used for rich-part iframes)
  const vdark = viewerThemeCss(gh, "dark");
  assert.ok(!vdark.includes("@media"), "viewer dark mode must not emit a media query");
  assert.ok(vdark.includes(`--bg: ${gh.dark.bg}`), "viewer dark --bg");
  // terminal vars still ride along (always the dark palette, scheme-independent)
  assert.ok(vdark.includes("--term-bg:"), "viewer keeps terminal vars when pinned");
});

test("omitting the mode preserves the OS media-query behavior unchanged", () => {
  const gh = themeById("github");
  for (const css of [tokenThemeCss(gh), tokenThemeCss(gh, undefined), viewerThemeCss(gh)]) {
    assert.ok(
      css.includes("@media (prefers-color-scheme: dark)"),
      "no-mode output keeps the dark-scheme override",
    );
  }
});

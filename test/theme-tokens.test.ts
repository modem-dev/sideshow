import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THEME_ID, themeById, viewerVars } from "../server/themes.ts";
import {
  THEME_DEFAULTS,
  THEME_TOKEN_NAMES,
  type ThemeTokens,
  themeTokens,
} from "../server/theme-tokens.ts";

// Every mirrored token name must be exactly its `viewerVars` key with the `--`
// prefix — that lockstep is what lets themeTokens() map one to the other with a
// plain slice. If viewerVars renames/drops a key this fails loudly.
test("every THEME_TOKEN_NAMES entry maps to a viewerVars key", () => {
  const keys = new Set(Object.keys(viewerVars(themeById(DEFAULT_THEME_ID).light)));
  for (const name of THEME_TOKEN_NAMES) {
    assert.ok(name.startsWith("--"), `${name} must be a CSS custom property`);
    assert.ok(keys.has(name.slice(2)), `${name} has no matching viewerVars key`);
  }
});

test("themeTokens resolves a complete, non-empty token set for both modes", () => {
  for (const mode of ["light", "dark"] as const) {
    const tokens = themeTokens(themeById(DEFAULT_THEME_ID), mode);
    for (const name of THEME_TOKEN_NAMES) {
      assert.equal(typeof tokens[name], "string", `${mode} ${name} should be a string`);
      assert.ok(tokens[name].length > 0, `${mode} ${name} should be non-empty`);
    }
  }
});

// THEME_DEFAULTS is the no-flash fallback hosts paint before JS — it must be the
// default theme's actual palette, derived (not hand-copied), so it can't drift.
test("THEME_DEFAULTS is derived from the default theme's palettes", () => {
  const def = themeById(DEFAULT_THEME_ID);
  for (const mode of ["light", "dark"] as const) {
    const vars = viewerVars(def[mode]);
    const expected = {} as ThemeTokens;
    for (const name of THEME_TOKEN_NAMES) expected[name] = vars[name.slice(2)];
    assert.deepEqual(THEME_DEFAULTS[mode], expected, `${mode} defaults`);
  }
  // Spot-check a concrete value so a silent registry edit is visible here.
  assert.equal(THEME_DEFAULTS.light["--bg"], def.light.bg);
  assert.equal(THEME_DEFAULTS.dark["--bg"], def.dark.bg);
});

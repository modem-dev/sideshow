// The engine↔embedder theme-token contract, as data.
//
// The embeddable engine renders its palette as CSS custom properties scoped to
// its (shadow) root. An embedding host — e.g. sideshow cloud — keeps its own
// chrome visually aligned by mirroring a subset of those vars. For that it needs
// two things as DATA, not by scraping the live DOM:
//   1. the NAMES of the tokens it mirrors (a stable, coarse subset), and
//   2. the engine's built-in DEFAULTS, so the host can paint correct colors
//      before the engine's JS has resolved a theme (the no-flash fallback).
//
// Both are DERIVED from the theme registry (themes.ts) via the same `viewerVars`
// mapping the chrome itself uses, so they can never drift from what the engine
// ships. This module is runtime-agnostic (it imports only themes.ts, which has
// no node/DOM dependencies): it is safe to import in a Node build script and to
// bundle into a browser host WITHOUT pulling in the viewer runtime. Published as
// the lightweight `sideshow/theme-tokens` entry for exactly that reason.
import { DEFAULT_THEME_ID, type Mode, type Theme, themeById, viewerVars } from "./themes.ts";

// The palette tokens a host mirrors onto its own chrome. A deliberately coarse
// subset of the engine's vars — the host needs the base palette, not the
// per-state (--color-*) or terminal (--term-*) tokens. Adding a name here is a
// shared contract change. The order is cosmetic (drives generated CSS output).
export const THEME_TOKEN_NAMES = [
  "--bg",
  "--panel",
  "--surface",
  "--text",
  "--muted",
  "--faint",
  "--border",
  "--border-2",
  "--accent",
  "--accent-bg",
  "--hover",
  "--danger",
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Record<ThemeTokenName, string>;

// Resolve a theme + color scheme to the `--`-prefixed token subset above.
// `viewerVars` keys are unprefixed (bg, border-2, accent-bg, …); each token name
// is exactly its `viewerVars` key with the leading `--` stripped, so a single
// slice keeps the two in lockstep.
export function themeTokens(theme: Theme, mode: Mode): ThemeTokens {
  const vars = viewerVars(theme[mode]);
  const out = {} as ThemeTokens;
  for (const name of THEME_TOKEN_NAMES) out[name] = vars[name.slice(2)];
  return out;
}

// Built-in default-theme values, so a host renders correct colors before JS.
// Derived from the default theme's palettes — not hand-copied hex.
export const THEME_DEFAULTS: Record<Mode, ThemeTokens> = {
  light: themeTokens(themeById(DEFAULT_THEME_ID), "light"),
  dark: themeTokens(themeById(DEFAULT_THEME_ID), "dark"),
};

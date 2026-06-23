// Theme registry — the single source of truth for the board's palette, shared
// by the server (html-part token injection in surfacePage) and the viewer
// (chrome palette + shiki theme for markdown/diff). Runtime-agnostic: no node
// imports, so it bundles into the viewer (vite) and typechecks against workers.
//
// A theme is authored as ONE palette object per color scheme; the viewer-var
// set (--bg, --accent, …) and the html-token set (--color-* injected into the
// sandboxed iframe) are both DERIVED from it, so the two palettes can never
// drift. Mermaid follows the viewer vars (see MermaidPart); the terminal is
// intentionally theme-independent (always a dark terminal window).

export interface Accent {
  // Background fill, text/icon color, and border for a semantic state.
  bg: string;
  text: string;
  border: string;
}

export interface Palette {
  bg: string; // app background (deepest chrome)
  panel: string; // raised panel / code-block background
  surface: string; // card / html-part body background
  text: string; // primary text
  muted: string; // secondary text
  faint: string; // tertiary text (captions, hints)
  border: string; // default hairline border
  border2: string; // stronger border
  hover: string; // hover wash
  info: Accent; // also the accent color (links, focus)
  success: Accent;
  warning: Accent;
  danger: Accent;
}

export interface Theme {
  id: string;
  label: string;
  // Shiki theme names (bundled) for markdown code + diffs, by color scheme.
  shiki: { light: string; dark: string };
  light: Palette;
  dark: Palette;
}

// A resolved color scheme. The chrome resolves this from the OS via a CSS
// `@media (prefers-color-scheme)` query; surface iframes are separate documents
// that don't reliably inherit that resolution, so the viewer passes the mode it
// resolved into each frame to pin it to the chrome (see surfacePage / Card).
export type Mode = "light" | "dark";

// Viewer chrome variables (styles.css names). Accent maps to the info state.
// Exported so the embed theme-token manifest (theme-tokens.ts) derives the host
// contract's token defaults from the same mapping the chrome uses — one source.
export function viewerVars(p: Palette): Record<string, string> {
  return {
    bg: p.bg,
    panel: p.panel,
    surface: p.surface,
    text: p.text,
    muted: p.muted,
    faint: p.faint,
    border: p.border,
    "border-2": p.border2,
    accent: p.info.text,
    "accent-bg": p.info.bg,
    hover: p.hover,
    danger: p.danger.text,
  };
}

// Html-part design tokens (surfacePage names — the agent-facing contract).
// Same variable NAMES across every theme; only the values change.
function tokenVars(p: Palette): Record<string, string> {
  return {
    "color-background-primary": p.surface,
    "color-background-secondary": p.panel,
    "color-background-tertiary": p.bg,
    "color-background-info": p.info.bg,
    "color-background-success": p.success.bg,
    "color-background-warning": p.warning.bg,
    "color-background-danger": p.danger.bg,
    "color-text-primary": p.text,
    "color-text-secondary": p.muted,
    "color-text-tertiary": p.faint,
    "color-text-info": p.info.text,
    "color-text-success": p.success.text,
    "color-text-warning": p.warning.text,
    "color-text-danger": p.danger.text,
    "color-border-primary": p.border2,
    "color-border-secondary": p.border,
    "color-border-tertiary": p.border,
    "color-border-info": p.info.border,
    "color-border-success": p.success.border,
    "color-border-warning": p.warning.border,
    "color-border-danger": p.danger.border,
  };
}

// Terminal chrome. Always sourced from the theme's DARK palette (a terminal
// reads as a terminal — ANSI output assumes a dark backdrop — so it stays dark
// in light mode too), but tinted to the theme so it doesn't look foreign.
function termVars(dark: Palette): Record<string, string> {
  return {
    "term-bg": dark.bg,
    "term-bar": dark.panel,
    "term-fg": dark.text,
    "term-title": dark.muted,
  };
}

const block = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => `--${k}: ${v};`)
    .join("");

// `:root` light + a `prefers-color-scheme: dark` override — emitted as a
// <style> so the automatic OS light/dark flip keeps working with no JS. When
// `mode` is given the scheme is PINNED to it instead: a single flat `:root`
// block with no media query, so the document renders that mode regardless of
// the OS preference. The viewer uses this to force a surface iframe to the mode
// the chrome already resolved, since an iframe is a separate document whose
// `prefers-color-scheme` evaluation can diverge from its embedder's.
export function schemeCss(
  light: Record<string, string>,
  dark: Record<string, string>,
  mode?: Mode,
): string {
  if (mode === "light") return `:root{${block(light)}}`;
  if (mode === "dark") return `:root{${block(dark)}}`;
  return `:root{${block(light)}}@media (prefers-color-scheme: dark){:root{${block(dark)}}}`;
}

// Viewer chrome palette CSS (injected into the viewer document head). The
// scheme-flipping chrome vars, plus the terminal vars which are scheme-
// independent (always the dark palette) so they sit outside the media query.
// `mode` pins the scheme (see schemeCss) — used for the rich-part iframes the
// chrome renders via renderSandboxedPart, not the chrome's own <head>.
export function viewerThemeCss(t: Theme, mode?: Mode): string {
  return `${schemeCss(viewerVars(t.light), viewerVars(t.dark), mode)}:root{${block(termVars(t.dark))}}`;
}

// Html-part token CSS (injected into each sandboxed surface iframe). `mode`
// pins the scheme so the iframe matches the chrome (see schemeCss).
export function tokenThemeCss(t: Theme, mode?: Mode): string {
  return schemeCss(tokenVars(t.light), tokenVars(t.dark), mode);
}

export const THEMES: Theme[] = [
  {
    id: "github",
    label: "GitHub",
    shiki: { light: "github-light", dark: "github-dark" },
    light: {
      bg: "#f6f8fa",
      panel: "#eaeef2",
      surface: "#ffffff",
      text: "#1f2328",
      muted: "#59636e",
      faint: "#818b98",
      border: "#d1d9e0",
      border2: "#afb8c1",
      hover: "#eaeef2",
      info: { bg: "#ddf4ff", text: "#0969da", border: "#54aeff" },
      success: { bg: "#dafbe1", text: "#1a7f37", border: "#4ac26b" },
      warning: { bg: "#fff8c5", text: "#9a6700", border: "#d4a72c" },
      danger: { bg: "#ffebe9", text: "#cf222e", border: "#ff8182" },
    },
    dark: {
      bg: "#0d1117",
      panel: "#161b22",
      surface: "#1c2128",
      text: "#e6edf3",
      muted: "#9198a1",
      faint: "#6e7681",
      border: "#30363d",
      border2: "#444c56",
      hover: "rgba(177, 186, 196, 0.12)",
      info: { bg: "rgba(56, 139, 253, 0.15)", text: "#4493f8", border: "#54aeff" },
      success: { bg: "rgba(63, 185, 80, 0.15)", text: "#3fb950", border: "#4ac26b" },
      warning: { bg: "rgba(210, 153, 34, 0.15)", text: "#d29922", border: "#d4a72c" },
      danger: { bg: "rgba(248, 81, 73, 0.15)", text: "#ff7b72", border: "#ff8182" },
    },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    shiki: { light: "gruvbox-light-hard", dark: "gruvbox-dark-hard" },
    light: {
      bg: "#f9f5d7",
      panel: "#ebdbb2",
      surface: "#fbf1c7",
      text: "#3c3836",
      muted: "#665c54",
      faint: "#928374",
      border: "#d5c4a1",
      border2: "#bdae93",
      hover: "#ebdbb2",
      info: { bg: "#d7e5e8", text: "#076678", border: "#458588" },
      success: { bg: "#e8ecc8", text: "#79740e", border: "#98971a" },
      warning: { bg: "#f5e6c8", text: "#b57614", border: "#d79921" },
      danger: { bg: "#fbe3d8", text: "#9d0006", border: "#cc241d" },
    },
    dark: {
      bg: "#1d2021",
      panel: "#282828",
      surface: "#32302f",
      text: "#ebdbb2",
      muted: "#a89984",
      faint: "#928374",
      border: "#504945",
      border2: "#665c54",
      hover: "#3c3836",
      info: { bg: "rgba(131, 165, 152, 0.18)", text: "#83a598", border: "#458588" },
      success: { bg: "rgba(184, 187, 38, 0.18)", text: "#b8bb26", border: "#98971a" },
      warning: { bg: "rgba(250, 189, 47, 0.18)", text: "#fabd2f", border: "#d79921" },
      danger: { bg: "rgba(251, 73, 52, 0.18)", text: "#fb4934", border: "#cc241d" },
    },
  },
  {
    id: "one",
    label: "One",
    shiki: { light: "one-light", dark: "one-dark-pro" },
    light: {
      bg: "#fafafa",
      panel: "#f0f0f1",
      surface: "#ffffff",
      text: "#383a42",
      muted: "#696c77",
      faint: "#a0a1a7",
      border: "#d4d4d6",
      border2: "#b9b9bd",
      hover: "#f0f0f1",
      info: { bg: "#e6effd", text: "#4078f2", border: "#88aef8" },
      success: { bg: "#e8f3e8", text: "#50a14f", border: "#97c997" },
      warning: { bg: "#faf0dd", text: "#986801", border: "#d9a441" },
      danger: { bg: "#fce8e8", text: "#e45649", border: "#ef9a92" },
    },
    dark: {
      bg: "#282c34",
      panel: "#21252b",
      surface: "#2f343d",
      text: "#abb2bf",
      muted: "#828997",
      faint: "#5c6370",
      border: "#3e4451",
      border2: "#545b66",
      hover: "#2c313a",
      info: { bg: "rgba(97, 175, 239, 0.16)", text: "#61afef", border: "#61afef" },
      success: { bg: "rgba(152, 195, 121, 0.16)", text: "#98c379", border: "#98c379" },
      warning: { bg: "rgba(229, 192, 123, 0.16)", text: "#e5c07b", border: "#e5c07b" },
      danger: { bg: "rgba(224, 108, 117, 0.16)", text: "#e06c75", border: "#e06c75" },
    },
  },
  {
    id: "solarized",
    label: "Solarized",
    shiki: { light: "solarized-light", dark: "solarized-dark" },
    light: {
      bg: "#eee8d5",
      panel: "#e3dcc9",
      surface: "#fdf6e3",
      text: "#586e75",
      muted: "#657b83",
      faint: "#93a1a1",
      border: "#d9d2bf",
      border2: "#c4bca6",
      hover: "#e3dcc9",
      info: { bg: "#dce9f3", text: "#268bd2", border: "#6aa9db" },
      success: { bg: "#ebedcf", text: "#859900", border: "#a8b520" },
      warning: { bg: "#f3ead0", text: "#b58900", border: "#cda632" },
      danger: { bg: "#f7dcd5", text: "#dc322f", border: "#e08b86" },
    },
    dark: {
      bg: "#002b36",
      panel: "#073642",
      surface: "#0a4250",
      text: "#93a1a1",
      muted: "#839496",
      faint: "#586e75",
      border: "#0f4b59",
      border2: "#1a5b6b",
      hover: "#073642",
      info: { bg: "rgba(38, 139, 210, 0.18)", text: "#268bd2", border: "#268bd2" },
      success: { bg: "rgba(133, 153, 0, 0.2)", text: "#859900", border: "#859900" },
      warning: { bg: "rgba(181, 137, 0, 0.2)", text: "#b58900", border: "#b58900" },
      danger: { bg: "rgba(220, 50, 47, 0.2)", text: "#dc322f", border: "#dc322f" },
    },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    shiki: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
    light: {
      bg: "#e6e9ef",
      panel: "#dce0e8",
      surface: "#eff1f5",
      text: "#4c4f69",
      muted: "#6c6f85",
      faint: "#8c8fa1",
      border: "#ccd0da",
      border2: "#bcc0cc",
      hover: "#dce0e8",
      info: { bg: "#dce4fb", text: "#1e66f5", border: "#7e9bf7" },
      success: { bg: "#dcecd6", text: "#40a02b", border: "#8cc47e" },
      warning: { bg: "#f7ead2", text: "#df8e1d", border: "#ebbe6f" },
      danger: { bg: "#f7d6dd", text: "#d20f39", border: "#e58a9c" },
    },
    dark: {
      bg: "#11111b",
      panel: "#181825",
      surface: "#1e1e2e",
      text: "#cdd6f4",
      muted: "#a6adc8",
      faint: "#7f849c",
      border: "#313244",
      border2: "#45475a",
      hover: "#313244",
      info: { bg: "rgba(137, 180, 250, 0.16)", text: "#89b4fa", border: "#89b4fa" },
      success: { bg: "rgba(166, 227, 161, 0.16)", text: "#a6e3a1", border: "#a6e3a1" },
      warning: { bg: "rgba(249, 226, 175, 0.16)", text: "#f9e2af", border: "#f9e2af" },
      danger: { bg: "rgba(243, 139, 168, 0.16)", text: "#f38ba8", border: "#f38ba8" },
    },
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    shiki: { light: "rose-pine-dawn", dark: "rose-pine-moon" },
    light: {
      bg: "#faf4ed",
      panel: "#f2e9e1",
      surface: "#fffaf3",
      text: "#575279",
      muted: "#797593",
      faint: "#9893a5",
      border: "#dfdad9",
      border2: "#cecacd",
      hover: "#f4ede8",
      // Rosé Pine has no green; foam (teal) stands in for success.
      info: { bg: "#dde9ec", text: "#286983", border: "#56949f" },
      success: { bg: "#dcebed", text: "#56949f", border: "#56949f" },
      warning: { bg: "#f7ecd3", text: "#ea9d34", border: "#ea9d34" },
      danger: { bg: "#f5dfe3", text: "#b4637a", border: "#b4637a" },
    },
    dark: {
      bg: "#232136",
      panel: "#393552",
      surface: "#2a273f",
      text: "#e0def4",
      muted: "#908caa",
      faint: "#6e6a86",
      border: "#44415a",
      border2: "#56526e",
      hover: "#393552",
      info: { bg: "rgba(62, 143, 176, 0.18)", text: "#3e8fb0", border: "#3e8fb0" },
      success: { bg: "rgba(156, 207, 216, 0.16)", text: "#9ccfd8", border: "#9ccfd8" },
      warning: { bg: "rgba(246, 193, 119, 0.16)", text: "#f6c177", border: "#f6c177" },
      danger: { bg: "rgba(235, 111, 146, 0.16)", text: "#eb6f92", border: "#eb6f92" },
    },
  },
  {
    id: "everforest",
    label: "Everforest",
    shiki: { light: "everforest-light", dark: "everforest-dark" },
    light: {
      bg: "#f5f1e0",
      panel: "#efebd8",
      surface: "#fffbef",
      text: "#5c6a72",
      muted: "#829181",
      faint: "#939f91",
      border: "#e0dcc7",
      border2: "#cbc8b5",
      hover: "#efebd8",
      info: { bg: "#dceaf1", text: "#3a94c5", border: "#7bb6d6" },
      success: { bg: "#e8ecc8", text: "#8da101", border: "#b3bf55" },
      warning: { bg: "#f5ecca", text: "#dfa000", border: "#e6bf52" },
      danger: { bg: "#fadfd9", text: "#f85552", border: "#f49b97" },
    },
    dark: {
      bg: "#232a2e",
      panel: "#343f44",
      surface: "#2d353b",
      text: "#d3c6aa",
      muted: "#9da9a0",
      faint: "#7a8478",
      border: "#3d484d",
      border2: "#475258",
      hover: "#343f44",
      info: { bg: "rgba(127, 187, 179, 0.16)", text: "#7fbbb3", border: "#7fbbb3" },
      success: { bg: "rgba(167, 192, 128, 0.16)", text: "#a7c080", border: "#a7c080" },
      warning: { bg: "rgba(219, 188, 127, 0.16)", text: "#dbbc7f", border: "#dbbc7f" },
      danger: { bg: "rgba(230, 126, 128, 0.16)", text: "#e67e80", border: "#e67e80" },
    },
  },
];

export const DEFAULT_THEME_ID = "github";

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

// Compact descriptor for the picker (avoids shipping full palettes to list).
export const themeOptions = () => THEMES.map((t) => ({ id: t.id, label: t.label }));

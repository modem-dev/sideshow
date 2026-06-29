// Viewer-side theme controller. The active theme drives three things:
//   1. the chrome palette — a <style> of viewerThemeCss injected into <head>,
//      overriding the static defaults in styles.css (later rule wins);
//   2. the shiki theme for markdown/diff — read reactively via activeTheme();
//   3. html surfaces — Card keys each iframe src on activeTheme(), so a
//      switch reloads the frame and the server re-injects matching tokens.
// The selection persists per-workspace server-side (PUT /api/theme); other open
// tabs re-theme via the theme-changed SSE event (see state.ts).
import { createSignal } from "solid-js";
import { api } from "./api.ts";
import { host, isShadow, styleContainer } from "./host.ts";
import { themeTokens } from "../../server/theme-tokens.ts";
import {
  DEFAULT_THEME_ID,
  type Mode,
  themeById,
  themeOptions,
  viewerThemeCss,
} from "../../server/themes.ts";

export { themeOptions };

export type ColorModePreference = "system" | Mode;

const COLOR_MODE_KEY = "sideshow:color-mode";
const COLOR_MODE_PREFERENCES: ColorModePreference[] = ["system", "light", "dark"];

function readColorModePreference(): ColorModePreference {
  try {
    const stored = localStorage.getItem(COLOR_MODE_KEY);
    return COLOR_MODE_PREFERENCES.includes(stored as ColorModePreference)
      ? (stored as ColorModePreference)
      : "system";
  } catch {
    return "system";
  }
}

const [activeThemeState, setActiveTheme] = createSignal(DEFAULT_THEME_ID);
export const activeTheme = activeThemeState;
const [colorModePreferenceState, setColorModePreferenceState] =
  createSignal<ColorModePreference>(readColorModePreference());
export const colorModePreference = colorModePreferenceState;

// The OS light/dark resolution — the same signal the chrome's injected
// `@media (prefers-color-scheme: dark)` rules key off. Surfaces render in
// separate iframes whose own scheme resolution can diverge from the chrome's
// (an embedder doesn't reliably propagate it across the frame boundary), so
// each frame is pinned to this mode instead — every surface frame carries it as
// the `/s/:id?mode=` query param, so the server bakes the resolved scheme into
// the rendered doc. It is reactive, so an OS flip reloads the frames in lockstep
// with the chrome.
const darkQuery =
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
const [prefersDark, setPrefersDark] = createSignal(!!darkQuery?.matches);
export const resolvedMode = (): Mode => {
  const preference = colorModePreferenceState();
  if (preference !== "system") return preference;
  return prefersDark() ? "dark" : "light";
};

// On an OS light/dark flip the resolved palette changes without a theme change,
// so re-push it to the host (below) after updating the mode signal. If the user
// has forced light/dark, the OS change does not affect the resolved mode.
function syncModeCookie() {
  document.cookie = `sideshow_mode=${resolvedMode()};path=/;max-age=31536000;SameSite=Lax`;
}
syncModeCookie();
darkQuery?.addEventListener("change", (e) => {
  setPrefersDark(e.matches);
  syncModeCookie();
  if (colorModePreferenceState() === "system") emitThemeTokens();
});

// Push the fully-resolved palette to the host. Symmetric with router.navigate:
// the engine owns the themes and TELLS the host its colors (on initial apply, on
// a live theme switch, and on an OS scheme flip) instead of the host scraping
// them across the shadow boundary. Optional on the contract — the trivial
// self-hosted host omits onThemeChange, so this no-ops there.
function emitThemeTokens() {
  host().onThemeChange?.(themeTokens(themeById(activeThemeState()), resolvedMode()));
}

const STYLE_ID = "ss-theme-vars";

// Inject/replace the chrome-palette <style>. Appended to the engine root (the
// <head> self-hosted, the shadow root when embedded) so it follows the bundled
// styles.css and wins the cascade for the palette vars. Inside a shadow root the
// `:root` selector matches nothing, so the vars are re-homed onto `:host`.
function applyPalette(id: string) {
  const container = styleContainer();
  let el = container.querySelector<HTMLStyleElement>(`#${STYLE_ID}`);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    container.appendChild(el);
  }
  const preference = colorModePreferenceState();
  const scheme = preference === "system" ? undefined : preference;
  const colorSchemeCss = `:root{color-scheme:${scheme ?? "light dark"};}`;
  const css = `${viewerThemeCss(themeById(id), scheme)}${colorSchemeCss}`;
  el.textContent = isShadow() ? css.replace(/:root\b/g, ":host") : css;
}

// Apply locally without a server round-trip (used by initial load + SSE).
export function applyTheme(id: string) {
  const theme = themeById(id);
  applyPalette(theme.id);
  setActiveTheme(theme.id);
  syncModeCookie();
  emitThemeTokens();
}

// Fetch the persisted workspace theme on startup.
export async function initTheme() {
  const res = await api<{ id: string }>("/api/theme").catch(() => null);
  applyTheme(res?.id ?? DEFAULT_THEME_ID);
}

// User picked a theme: persist + apply. The PUT broadcasts theme-changed to
// other tabs; this tab applies immediately so it never waits on its own event.
export async function setTheme(id: string) {
  applyTheme(id);
  await api("/api/theme", { method: "PUT", body: JSON.stringify({ id }) }).catch(() => null);
}

// User picked a color mode: local to this browser, because "system" means the
// viewer should follow this device's OS preference.
export function setColorModePreference(preference: ColorModePreference) {
  setColorModePreferenceState(preference);
  try {
    localStorage.setItem(COLOR_MODE_KEY, preference);
  } catch {
    // Ignore unavailable storage; the in-memory choice still applies.
  }
  applyPalette(activeThemeState());
  syncModeCookie();
  emitThemeTokens();
}

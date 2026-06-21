// Viewer-side theme controller. The active theme drives three things:
//   1. the chrome palette — a <style> of viewerThemeCss injected into <head>,
//      overriding the static defaults in styles.css (later rule wins);
//   2. the shiki theme for markdown/diff — read reactively via activeTheme();
//   3. html surface parts — Card keys each iframe src on activeTheme(), so a
//      switch reloads the frame and the server re-injects matching tokens.
// The selection persists per-board server-side (PUT /api/theme); other open
// tabs re-theme via the theme-changed SSE event (see state.ts).
import { createSignal } from "solid-js";
import { api } from "./api.ts";
import { isShadow, styleContainer } from "./host.ts";
import { DEFAULT_THEME_ID, themeById, themeOptions, viewerThemeCss } from "../../server/themes.ts";

export { themeOptions };

const [activeThemeState, setActiveTheme] = createSignal(DEFAULT_THEME_ID);
export const activeTheme = activeThemeState;

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
  const css = viewerThemeCss(themeById(id));
  el.textContent = isShadow() ? css.replace(/:root\b/g, ":host") : css;
}

// Apply locally without a server round-trip (used by initial load + SSE).
export function applyTheme(id: string) {
  const theme = themeById(id);
  applyPalette(theme.id);
  setActiveTheme(theme.id);
}

// Fetch the persisted board theme on startup.
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

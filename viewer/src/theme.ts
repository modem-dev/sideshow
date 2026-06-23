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

const [activeThemeState, setActiveTheme] = createSignal(DEFAULT_THEME_ID);
export const activeTheme = activeThemeState;

// The OS light/dark resolution — the same signal the chrome's injected
// `@media (prefers-color-scheme: dark)` rules key off. Surface parts render in
// separate iframes whose own scheme resolution can diverge from the chrome's
// (an embedder doesn't reliably propagate it across the frame boundary), so
// each frame is pinned to this mode instead (Card html parts via the `mode`
// query param; SandboxedPart rich/comment frames via renderSandboxedPart). It
// is reactive, so an OS flip rebuilds the frames in lockstep with the chrome.
const darkQuery =
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
const [prefersDark, setPrefersDark] = createSignal(!!darkQuery?.matches);
// On an OS light/dark flip the resolved palette changes without a theme change,
// so re-push it to the host (below) after updating the mode signal.
darkQuery?.addEventListener("change", (e) => {
  setPrefersDark(e.matches);
  emitThemeTokens();
});
export const resolvedMode = (): Mode => (prefersDark() ? "dark" : "light");

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
  const css = viewerThemeCss(themeById(id));
  el.textContent = isShadow() ? css.replace(/:root\b/g, ":host") : css;
}

// Apply locally without a server round-trip (used by initial load + SSE).
export function applyTheme(id: string) {
  const theme = themeById(id);
  applyPalette(theme.id);
  setActiveTheme(theme.id);
  emitThemeTokens();
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

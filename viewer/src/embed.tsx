// Embeddable-engine entry point. The host (e.g. the sideshow cloud shell) loads
// this bundle and calls mountViewer(el, host) to render the viewer into a shadow
// root inside `el`. The engine carries its own Solid runtime, scopes all its DOM
// and styles to the shadow root, and reads its base path + route from the
// injected host. With no host it falls back to the default History-API host, so
// the bundle also works as a drop-in for the self-hosted page.
import { render } from "solid-js/web";
import App from "./App.tsx";
import { createDefaultHost, setEngine, type SideshowHost } from "./host.ts";
import stylesCss from "./styles.css?inline";

export type { SideshowHost, HostRouter, Route, SlotName } from "./host.ts";
// Runtime registry of host-overridable slot names (embedders project light DOM
// with these `slot=` attributes). Exported as a value so embedders share one
// source of truth instead of hardcoding the strings.
export { SLOTS } from "./host.ts";
// Theme-token contract: the names a host mirrors + the engine's built-in
// defaults, re-exported so consumers that already pull the engine bundle get
// them here. The canonical lightweight entry is `sideshow/theme-tokens`
// (engine-free, Node-safe) — prefer it in build scripts to avoid bundling the
// engine just to read these values.
export { THEME_TOKEN_NAMES, THEME_DEFAULTS } from "../../server/theme-tokens.ts";
export type { ThemeTokens, ThemeTokenName } from "../../server/theme-tokens.ts";

export interface ViewerHandle {
  dispose(): void;
}

// A shadow root has no <html>/<body>, so the document-level rules the viewer
// relies on (`html, body { height: 100% }`, the `body` background/color/font)
// match nothing. Here `:host` plays the role <body> plays in the self-hosted
// page: it carries the base appearance and a definite height, and the engine
// root fills the host-provided mount box exactly — so the viewer's
// `#app { height: 100% }` chains off a real height and fills the viewport.
// (Kept in sync with the `body` rule in styles.css.)
const EMBED_BASE_CSS = `
:host {
  display: block;
  position: relative;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.ss-engine-root { position: absolute; inset: 0; }
`;

export function mountViewer(el: Element, host?: SideshowHost): ViewerHandle {
  const shadow = el.attachShadow({ mode: "open" });

  // The viewer's stylesheet declares its palette vars on `:root`, which matches
  // nothing inside a shadow root — re-home them onto `:host` so they inherit
  // into the shadow tree. (The theme palette <style> is re-homed the same way
  // in theme.ts.) EMBED_BASE_CSS then re-homes the document-level layout that
  // <html>/<body> carried.
  const style = document.createElement("style");
  style.textContent = stylesCss.replace(/:root\b/g, ":host") + EMBED_BASE_CSS;
  shadow.appendChild(style);

  const mount = document.createElement("div");
  mount.className = "ss-engine-root";
  shadow.appendChild(mount);

  // Point the engine at the shadow root + host BEFORE rendering: App reads them
  // in onMount and module effects.
  setEngine(shadow, host ?? createDefaultHost());
  const dispose = render(() => <App />, mount);
  return { dispose };
}

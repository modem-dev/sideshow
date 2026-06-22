import { kitAssets } from "./kits.ts";
import {
  type Mode,
  schemeCss,
  type Theme,
  themeById,
  tokenThemeCss,
  viewerThemeCss,
} from "./themes.ts";

// The kit's two custom SVG accent ramps (teal, coral) aren't in the theme
// palette, so they carry their own light/dark values. Like the theme tokens
// they pin to a forced mode (no media query) when one is given, else flip with
// the OS — kept in sync via the shared schemeCss. Dark overrides only bg/text;
// the line color is shared, so it's repeated in both maps.
const KIT_ACCENTS_LIGHT: Record<string, string> = {
  "c-teal-bg": "#e1f4f1",
  "c-teal-line": "#1fa996",
  "c-teal-text": "#0c6e62",
  "c-coral-bg": "#fdece5",
  "c-coral-line": "#e8835e",
  "c-coral-text": "#a44f28",
};
const KIT_ACCENTS_DARK: Record<string, string> = {
  ...KIT_ACCENTS_LIGHT,
  "c-teal-bg": "rgba(31, 169, 150, 0.18)",
  "c-teal-text": "#6fd0c2",
  "c-coral-bg": "rgba(232, 131, 94, 0.18)",
  "c-coral-text": "#f0a987",
};
const kitAccentCss = (mode?: Mode): string => schemeCss(KIT_ACCENTS_LIGHT, KIT_ACCENTS_DARK, mode);

// When a scheme is pinned, force the document's used color-scheme to match so
// the UA-painted canvas, scrollbars, and native form controls follow it too
// (the token vars alone don't drive those). Overrides the static
// `color-scheme: light dark` default the kit/base CSS sets. Empty when the
// scheme is left to the OS, preserving the media-query behavior unchanged.
const colorSchemeCss = (mode?: Mode): string => (mode ? `:root{color-scheme:${mode}}` : "");

// Origins html parts may load external resources from. Mirrors the allowlist
// agents already know from Claude's inline widget surface.
const CDN_ALLOWLIST = [
  "https://cdnjs.cloudflare.com",
  "https://esm.sh",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

const cdns = CDN_ALLOWLIST.join(" ");

// `origin` is the server's own origin, added to img/media so uploaded assets
// (served at <origin>/a/:id) embed by URL. It is needed because the iframe runs
// at an opaque origin (sandbox without allow-same-origin), so `'self'` matches
// nothing, and a local http origin isn't covered by the `https:` source.
function buildCsp(origin: string): string {
  return [
    `default-src 'none'`,
    `script-src 'unsafe-inline' ${cdns}`,
    `style-src 'unsafe-inline' ${cdns}`,
    `font-src ${cdns} data:`,
    `img-src https: data: blob: ${origin}`,
    `connect-src ${cdns}`,
    `media-src https: data: blob: ${origin}`,
  ].join("; ");
}

// Static design tokens exposed to snippets — fonts and radii. The COLOR tokens
// (--color-*) are theme-dependent and injected separately by renderHtmlPage via
// tokenThemeCss(theme); names match Claude's widget surface either way so agents
// reuse the same muscle memory.
const TOKENS_CSS = `
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --border-radius-md: 8px;
  --border-radius-lg: 12px;
  --border-radius-xl: 16px;
}
html { box-sizing: border-box; scrollbar-width: none; }
html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; }
*, *::before, *::after { box-sizing: inherit; }
body {
  margin: 0;
  padding: 16px;
  background: var(--color-background-primary);
  color: var(--color-text-primary);
  font: 16px/1.6 var(--font-sans);
}
`;

// Snippet kit: element defaults and SVG utility classes baked into every
// snippet doc so agents publish compact markup instead of hand-writing inline
// CSS. Documented as a reference table in guide/DESIGN_GUIDE.md — keep the
// two in sync. Note: CSS rules override SVG presentation attributes, so bare
// element selectors here must never set properties snippets commonly set via
// attributes (fill/font-size on text, etc.) — that's why text styling is
// opt-in via classes.
const KIT_CSS = `
:root { color-scheme: light dark; }
button {
  font: 500 14px/1.4 var(--font-sans);
  color: var(--color-text-primary);
  background: none;
  border: 0.5px solid var(--color-border-secondary);
  border-radius: var(--border-radius-md);
  padding: 6px 14px;
  cursor: pointer;
}
button:hover { background: var(--color-background-secondary); }
input:not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea {
  font: 14px/1.4 var(--font-sans);
  color: var(--color-text-primary);
  background: var(--color-background-primary);
  border: 0.5px solid var(--color-border-secondary);
  border-radius: var(--border-radius-md);
  padding: 6px 10px;
  outline: none;
}
input:focus, select:focus, textarea:focus { border-color: var(--color-border-info); }
input::placeholder, textarea::placeholder { color: var(--color-text-tertiary); }
textarea { resize: vertical; }
input[type=checkbox], input[type=radio], input[type=range], progress {
  accent-color: var(--color-border-info);
}
svg { font-family: var(--font-sans); fill: var(--color-text-primary); }
.t { font-size: 14px; }
.ts { font-size: 12px; fill: var(--color-text-secondary); }
.th { font-size: 14px; font-weight: 500; }
.box { fill: var(--color-background-secondary); stroke: var(--color-border-tertiary); rx: 8px; }
.arr { stroke: var(--color-text-secondary); stroke-width: 1.2; fill: none; }
.leader { stroke: var(--color-border-secondary); stroke-width: 1; stroke-dasharray: 3 4; fill: none; }
.node { cursor: pointer; }
.node:hover { opacity: 0.75; }
.c-blue, .c-blue .box { fill: var(--color-background-info); stroke: var(--color-border-info); }
.c-blue text, text.c-blue { fill: var(--color-text-info); stroke: none; }
.c-teal, .c-teal .box { fill: var(--c-teal-bg); stroke: var(--c-teal-line); }
.c-teal text, text.c-teal { fill: var(--c-teal-text); stroke: none; }
.c-amber, .c-amber .box { fill: var(--color-background-warning); stroke: var(--color-border-warning); }
.c-amber text, text.c-amber { fill: var(--color-text-warning); stroke: none; }
.c-coral, .c-coral .box { fill: var(--c-coral-bg); stroke: var(--c-coral-line); }
.c-coral text, text.c-coral { fill: var(--c-coral-text); stroke: none; }
.c-green, .c-green .box { fill: var(--color-background-success); stroke: var(--color-border-success); }
.c-green text, text.c-green { fill: var(--color-text-success); stroke: none; }
.c-red, .c-red .box { fill: var(--color-background-danger); stroke: var(--color-border-danger); }
.c-red text, text.c-red { fill: var(--color-text-danger); stroke: none; }
.c-gray, .c-gray .box { fill: var(--color-background-secondary); stroke: var(--color-border-secondary); }
.c-gray text, text.c-gray { fill: var(--color-text-secondary); stroke: none; }
`;

// Shared SVG defs injected into every snippet doc. Inline SVGs anywhere in
// the document can reference these by id; the arrowhead inherits the
// referencing line's stroke color via context-stroke.
const SVG_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs></svg>`;

// Bridge to the host viewer: sendPrompt/openLink/copyToClipboard mirror
// Claude's widget globals, and a ResizeObserver reports content height so the
// parent can size the sandboxed (opaque-origin) iframe. copyToClipboard posts
// to the parent (trusted origin) which has clipboard API access; the sandbox
// itself is opaque-origin so navigator.clipboard is unavailable there.
const BRIDGE_JS = `
window.sendPrompt = function (text) {
  parent.postMessage({ __sideshow: true, type: 'send-prompt', text: String(text) }, '*');
};
window.openLink = function (url) {
  parent.postMessage({ __sideshow: true, type: 'open-link', url: String(url) }, '*');
};
window.copyToClipboard = function (text) {
  parent.postMessage({ __sideshow: true, type: 'copy', text: String(text) }, '*');
};
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (a && /^https?:/.test(a.href)) { e.preventDefault(); window.openLink(a.href); }
});
// Cmd+Option+Up/Down switches sessions in the sidebar, but keydowns fire in
// whichever document holds focus — once the user clicks into a snippet, this
// sandboxed iframe swallows them. Forward just that combo to the host.
document.addEventListener('keydown', function (e) {
  if (!e.metaKey || !e.altKey || e.ctrlKey || e.shiftKey) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  parent.postMessage({ __sideshow: true, type: 'switch-session', key: e.key }, '*');
});
var __lastH = 0;
function __report() {
  var h = document.body
    ? document.body.scrollHeight
    : document.documentElement.scrollHeight;
  if (h > 0 && h !== __lastH) {
    __lastH = h;
    parent.postMessage({ __sideshow: true, type: 'resize', height: h }, '*');
  }
}
if (document.readyState === 'complete') __report();
else window.addEventListener('load', function () { requestAnimationFrame(__report); });
setTimeout(__report, 60);
setTimeout(__report, 350);
setTimeout(__report, 1500);
if (window.ResizeObserver) {
  window.__ssRO = new ResizeObserver(__report);
  window.__ssRO.observe(document.documentElement);
  if (document.body) window.__ssRO.observe(document.body);
}
`;

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Wrap one html part in the themed, sandboxed document the iframe loads. The
// board's color tokens (theme-dependent) are injected first so the static base
// + kit resolve against them; `theme` defaults to the github preset.
// CSP for a rich part (markdown/mermaid/diff). These render markup our own
// libraries produced — they never load CDN scripts and never need the network,
// so the policy is *tighter* than an html part's: only the inline bridge runs,
// and there is no `connect-src`, so even if a sanitizer regression let agent
// markup execute, the script is boxed into an opaque origin with no way to
// phone home. `img-src origin` lets inline markdown images at <origin>/a/:id
// load (the iframe is opaque-origin, so `'self'` matches nothing — same reason
// buildCsp adds it explicitly).
function buildRichCsp(origin: string): string {
  return [
    `default-src 'none'`,
    `script-src 'unsafe-inline'`,
    `style-src 'unsafe-inline'`,
    `img-src https: data: blob: ${origin}`,
    `font-src data:`,
  ].join("; ");
}

// Wrap pre-rendered, *untrusted* markup (markdown HTML, a mermaid SVG, a diff's
// SSR output) in the same opaque-origin sandbox html parts get. The markup was
// built as a STRING in the trusted viewer (string building is not a DOM sink),
// and only becomes live DOM here, inside the iframe — so a markdown-it / shiki /
// mermaid / DOMPurify / @pierre-diffs sanitizer bypass can no longer reach the
// board. `css` is the part-specific stylesheet (prose/diff/mermaid rules);
// chrome theme vars come from viewerThemeCss so the part matches the viewer.
// `mode` PINS those vars (and any shiki dark-flip the css carries) to the
// scheme the chrome resolved, so this frame can't diverge from it. Unlike an
// html part, it deliberately does NOT force `color-scheme`: these frames are
// transparent so the themed card surface shows through, and a forced
// `color-scheme` would paint an opaque UA canvas behind them. They carry no
// native scrollbars/controls that need it, so the var pinning alone suffices.
export function renderSandboxedPart(doc: {
  body: string;
  css: string;
  origin: string;
  theme?: Theme | string;
  mode?: Mode;
}): string {
  const theme =
    typeof doc.theme === "string" || doc.theme == null ? themeById(doc.theme) : doc.theme;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${buildRichCsp(doc.origin)}">
<!-- srcdoc's base URL is about:srcdoc, so relative URLs (e.g. a markdown
     image at /a/:id) would not resolve; pin the base to the server origin.
     img-src in buildRichCsp allows that origin. (html parts don't need this —
     they load via /s/:id, whose URL is already the base.) -->
<base href="${doc.origin}/">
<style>${viewerThemeCss(theme, doc.mode)}${doc.css}</style>
</head>
<body>
${doc.body}
<script>${BRIDGE_JS}</script>
</body>
</html>`;
}

export function renderHtmlPage(doc: {
  title: string;
  html: string;
  origin: string;
  theme?: Theme | string;
  // Pins the iframe's color scheme to the one the chrome resolved (see Mode).
  // Omitted → the scheme follows the OS via tokenThemeCss's media query.
  mode?: Mode;
  // Opt-in kits (kits.ts): their CSS/JS is injected after the base kit. The JS
  // is plain inline script — same trust level as the bridge, already covered by
  // the html-part CSP's `script-src 'unsafe-inline'`. Unknown ids are ignored.
  kits?: string[];
}): string {
  const theme =
    typeof doc.theme === "string" || doc.theme == null ? themeById(doc.theme) : doc.theme;
  const kit = kitAssets(doc.kits);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(doc.origin)}">
<title>${escapeHtml(doc.title)}</title>
<style>${tokenThemeCss(theme, doc.mode)}${TOKENS_CSS}${KIT_CSS}${kitAccentCss(doc.mode)}${kit.css}${colorSchemeCss(doc.mode)}</style>
</head>
<body>
${SVG_DEFS}
${doc.html}
<script>${BRIDGE_JS}</script>
${kit.js ? `<script>${kit.js}</script>` : ""}
</body>
</html>`;
}

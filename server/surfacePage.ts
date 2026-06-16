// Origins html parts may load external resources from. Mirrors the allowlist
// agents already know from Claude's inline widget surface.
export const CDN_ALLOWLIST = [
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

// Design tokens exposed to snippets. Names match Claude's widget surface so
// agents can reuse the same muscle memory. Both modes are always defined.
const TOKENS_CSS = `
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --border-radius-md: 8px;
  --border-radius-lg: 12px;
  --border-radius-xl: 16px;
  --color-background-primary: #ffffff;
  --color-background-secondary: #f5f4ed;
  --color-background-tertiary: #faf9f5;
  --color-background-info: #e6f1fb;
  --color-background-danger: #fcebeb;
  --color-background-success: #eaf3de;
  --color-background-warning: #faeeda;
  --color-text-primary: #1a1915;
  --color-text-secondary: #5f5e56;
  --color-text-tertiary: #8e8d83;
  --color-text-info: #185fa5;
  --color-text-danger: #a32d2d;
  --color-text-success: #3b6d11;
  --color-text-warning: #854f0b;
  --color-border-primary: rgba(20, 20, 10, 0.4);
  --color-border-secondary: rgba(20, 20, 10, 0.25);
  --color-border-tertiary: rgba(20, 20, 10, 0.12);
  --color-border-info: #378add;
  --color-border-danger: #e24b4a;
  --color-border-success: #97c459;
  --color-border-warning: #ef9f27;
}
@media (prefers-color-scheme: dark) {
  :root {
    --color-background-primary: #2a2925;
    --color-background-secondary: #21201c;
    --color-background-tertiary: #1b1a17;
    --color-background-info: rgba(55, 138, 221, 0.18);
    --color-background-danger: rgba(226, 75, 74, 0.18);
    --color-background-success: rgba(151, 196, 89, 0.18);
    --color-background-warning: rgba(239, 159, 39, 0.18);
    --color-text-primary: #eceadf;
    --color-text-secondary: #b3b1a4;
    --color-text-tertiary: #8a887c;
    --color-text-info: #85b7eb;
    --color-text-danger: #f09595;
    --color-text-success: #c0dd97;
    --color-text-warning: #fac775;
    --color-border-primary: rgba(255, 255, 250, 0.4);
    --color-border-secondary: rgba(255, 255, 250, 0.25);
    --color-border-tertiary: rgba(255, 255, 250, 0.12);
  }
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
:root {
  color-scheme: light dark;
  --c-teal-bg: #e1f4f1; --c-teal-line: #1fa996; --c-teal-text: #0c6e62;
  --c-coral-bg: #fdece5; --c-coral-line: #e8835e; --c-coral-text: #a44f28;
}
@media (prefers-color-scheme: dark) {
  :root {
    --c-teal-bg: rgba(31, 169, 150, 0.18); --c-teal-text: #6fd0c2;
    --c-coral-bg: rgba(232, 131, 94, 0.18); --c-coral-text: #f0a987;
  }
}
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

// Bridge to the host viewer: sendPrompt/openLink mirror Claude's widget
// globals, and a ResizeObserver reports content height so the parent can
// size the sandboxed (opaque-origin) iframe.
const BRIDGE_JS = `
window.sendPrompt = function (text) {
  parent.postMessage({ __sideshow: true, type: 'send-prompt', text: String(text) }, '*');
};
window.openLink = function (url) {
  parent.postMessage({ __sideshow: true, type: 'open-link', url: String(url) }, '*');
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

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Wrap one html part in the themed, sandboxed document the iframe loads.
export function renderHtmlPage(doc: { title: string; html: string; origin: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(doc.origin)}">
<title>${escapeHtml(doc.title)}</title>
<style>${TOKENS_CSS}${KIT_CSS}</style>
</head>
<body>
${SVG_DEFS}
${doc.html}
<script>${BRIDGE_JS}</script>
</body>
</html>`;
}

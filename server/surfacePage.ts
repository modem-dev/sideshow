import { kitAssets } from "./kits.ts";
import {
  type Mode,
  type Palette,
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

// Origins html surfaces may load external resources from. Mirrors the allowlist
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

// Static design tokens exposed to html surfaces — fonts and radii. The COLOR tokens
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

// Surface kit: element defaults and SVG utility classes baked into every
// html-surface doc so agents publish compact markup instead of hand-writing inline
// CSS. Documented as a reference table in guide/DESIGN_GUIDE.md — keep the
// two in sync. Note: CSS rules override SVG presentation attributes, so bare
// element selectors here must never set properties surfaces commonly set via
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

// Shared SVG defs injected into every html-surface doc. Inline SVGs anywhere in
// the document can reference these by id; the arrowhead inherits the
// referencing line's stroke color via context-stroke.
const SVG_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs></svg>`;

// Bridge to the host viewer: sendPrompt/openLink/copyToClipboard mirror
// Claude's widget globals, and a ResizeObserver reports content height so the
// parent can size the sandboxed (opaque-origin) iframe. copyToClipboard posts
// to the parent (trusted origin) which has clipboard API access; the sandbox
// itself is opaque-origin so navigator.clipboard is unavailable there.
// Exported so the resize-guard regression test can run the exact shipped script
// in a vm, instead of scraping it back out of rendered HTML.
export const BRIDGE_JS = `
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
// whichever document holds focus — once the user clicks into a surface, this
// sandboxed iframe swallows them. Forward just that combo to the host.
document.addEventListener('keydown', function (e) {
  if (!e.metaKey || !e.altKey || e.ctrlKey || e.shiftKey) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  parent.postMessage({ __sideshow: true, type: 'switch-session', key: e.key }, '*');
});
// Report content height to the parent so it can size this iframe, while
// breaking a feedback loop that can peg a CPU core.
//
// The loop: the parent sets the iframe's height to whatever we report, but some
// content's height *inverts* with the frame's height — a scrollbar that appears
// at height A reflows the content to height B, then disappears at B and reflows
// back to A (or any 100vh / percentage-derived layout). The ResizeObserver then
// fires on every flip, so reported heights alternate A, B, A, B... forever. With
// a cheap surface that's a brief blip; with a heavy one (a big syntax-highlighted
// diff/markdown surface) each relayout is expensive and the tab sits at 100% CPU
// until the surface unmounts.
//
// A plain h !== __lastH guard can't stop this: in a 2-cycle every value differs
// from the one immediately before it. So we remember the previous height too and
// defer a return to it *if it recurs faster than a human could* (< 250ms) — that's
// the runaway. The deferred pass keeps one trailing re-measure and reports the
// taller height in the pair, so an ordinary font/image reflow can't leave the
// frame permanently clipped.
var __lastH = 0;
var __prevH = 0;
var __lastT = 0;
var __seenH = 0;
var __trailTimer = 0;
var __trailH = 0;
var __FLIP_MS = 250;
var __TRAIL_MS = 350;
function __now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
function __measureHeight() {
  return document.body
    ? document.body.scrollHeight
    : document.documentElement.scrollHeight;
}
function __postHeight(h, t) {
  __prevH = __lastH;
  __lastH = h;
  __lastT = t;
  parent.postMessage({ __sideshow: true, type: 'resize', height: h }, '*');
}
function __clearTrailing() {
  if (__trailTimer && typeof clearTimeout !== 'undefined') clearTimeout(__trailTimer);
  __trailTimer = 0;
  __trailH = 0;
}
function __flushTrailing() {
  __trailTimer = 0;
  var measured = __measureHeight();
  if (measured > 0) __seenH = measured;
  var target = Math.max(__trailH || 0, measured || 0);
  __trailH = 0;
  if (target <= 0 || target === __lastH) return;
  __postHeight(target, __now());
}
function __scheduleTrailing(h, reset) {
  __trailH = Math.max(__trailH || 0, h || 0, __lastH || 0);
  if (__trailTimer) {
    if (!reset) return;
    if (typeof clearTimeout !== 'undefined') clearTimeout(__trailTimer);
  }
  __trailTimer = setTimeout(__flushTrailing, __TRAIL_MS);
}
function __report() {
  var h = __measureHeight();
  if (h <= 0) return; // no content yet
  var changed = h !== __seenH;
  __seenH = h;
  if (h === __lastH) return; // unchanged
  var t = __now();
  if (h === __prevH && (__trailTimer || t - __lastT < __FLIP_MS)) {
    __scheduleTrailing(h, true); // rapid A<->B flip: defer one settled report
    return;
  }
  __clearTrailing();
  __postHeight(h, t);
}
if (document.readyState === 'complete') __report();
else window.addEventListener('load', function () { requestAnimationFrame(__report); });
setTimeout(__report, 60);
setTimeout(__report, 350);
setTimeout(__report, 1500);
setTimeout(__report, 3000);
setTimeout(__report, 6000);
setTimeout(__report, 10000);
if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
  document.fonts.ready.then(function () { __report(); });
}
if (window.ResizeObserver) {
  window.__ssRO = new ResizeObserver(__report);
  window.__ssRO.observe(document.documentElement);
  if (document.body) window.__ssRO.observe(document.body);
}
`;

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Wrap one html surface in the themed, sandboxed document the iframe loads. The
// workspace's color tokens (theme-dependent) are injected first so the static base
// + kit resolve against them; `theme` defaults to the github preset.
// CSP for a rich surface (markdown/mermaid/diff). These render markup our own
// libraries produced — they never load CDN scripts and never need the network,
// so the policy is *tighter* than an html surface's: only the inline bridge runs,
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
// SSR output) in the same opaque-origin sandbox html surfaces get. The markup was
// built as a STRING in the trusted viewer (string building is not a DOM sink),
// and only becomes live DOM here, inside the iframe — so a markdown-it / shiki /
// mermaid / DOMPurify / @pierre-diffs sanitizer bypass can no longer reach the
// workspace. `css` is the surface-specific stylesheet (prose/diff/mermaid rules);
// chrome theme vars come from viewerThemeCss so the surface matches the viewer.
// `mode` PINS those vars (and any shiki dark-flip the css carries) to the
// scheme the chrome resolved, so this frame can't diverge from it. Unlike an
// html surface, it deliberately does NOT force `color-scheme`: these frames are
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
     img-src in buildRichCsp allows that origin. (html surfaces don't need this —
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

// Mermaid can't run without a DOM, so it can't be server-rendered like the
// other rich surfaces; instead the server emits a self-rendering doc that loads
// mermaid from the CDN allowlist and renders inside the sandboxed iframe (the
// "(B)" path). Unlike the other rich surfaces it needs CDN script/connect access,
// so it uses the html-surface CSP (buildCsp), NOT the tight rich CSP. mermaid's
// own DOMPurify (securityLevel 'strict') runs first; the opaque origin is the
// second boundary. Theme colors are baked into the diagram at render time, so —
// like shiki's flip — they're PINNED to the chrome-resolved mode the viewer
// passed (mermaid can't do a media-query flip); absent mode defaults to light.

const MERMAID_CSS = `
body { margin: 0; padding: 14px 16px; background: transparent; text-align: center; }
svg { max-width: 100%; height: auto; }
.mmd-error {
  text-align: left; color: var(--danger);
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.mmd-error pre {
  margin: 6px 0 0; padding: 8px 10px; color: var(--text);
  background: var(--panel); border: 0.5px solid var(--border);
  border-radius: 8px; overflow: auto; white-space: pre-wrap;
}
`;

// Mermaid `base` theme variables + themeCSS derived from the resolved palette,
// so the diagram matches sideshow's look instead of mermaid's stock theme.
// Mirrors sideshowTheme() in the old viewer MermaidPart, but reads palette
// fields directly rather than getComputedStyle.
//
// `mode` must match the scheme `p` was resolved into (renderMermaidPage picks
// the palette off the same mode): mermaid's `base` theme DERIVES every variable
// we don't set here, and many of those derivations branch on a `darkMode` flag
// (row stripes, the cScale/surface color ramps, the edge-label background).
// Leave it unset and they're all computed for a light canvas, so they never
// flip — "some of the diagram changes on toggle, but not all of it."
function mermaidThemeVars(
  p: Palette,
  mode?: Mode,
): {
  themeVariables: Record<string, string | boolean>;
  themeCSS: string;
} {
  const text = p.text;
  const muted = p.muted;
  const border = p.border2;
  const panel = p.panel;
  const surface = p.surface;
  const bg = p.bg;
  const accent = p.info.text;
  const accentBg = p.info.bg;
  return {
    themeVariables: {
      // Pin the scheme so mermaid's darkMode-branched derivations resolve the
      // same way the palette we read from did (both come from `mode`).
      darkMode: mode === "dark",
      fontFamily: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
      fontSize: "14px",
      // The canvas mermaid derives against. Several colors default to
      // invert(background) — most visibly `arrowheadColor` — so a pinned value
      // here is what lets them track the theme instead of inverting the
      // hardcoded #f4f4f4 default (which stays light in both modes). Use the
      // real backdrop the SVG sits on (the card surface).
      background: surface,
      primaryColor: panel,
      primaryBorderColor: border,
      primaryTextColor: text,
      secondaryColor: surface,
      tertiaryColor: bg,
      mainBkg: panel,
      nodeBorder: border,
      lineColor: muted,
      // Arrowheads default to invert(background); point them at the line color
      // so the whole edge reads as one color in both schemes.
      arrowheadColor: muted,
      textColor: text,
      // Text colors mermaid would otherwise invert()-derive from box/canvas
      // colors. Pin them to our text token so every label — node, title,
      // cluster, class-member — reads as the viewer's text color in both modes.
      nodeTextColor: text,
      titleColor: text,
      classText: text,
      secondaryTextColor: text,
      tertiaryTextColor: text,
      clusterBkg: bg,
      clusterBorder: border,
      edgeLabelBackground: bg,
      actorBkg: panel,
      actorBorder: border,
      actorTextColor: text,
      actorLineColor: muted,
      signalColor: muted,
      signalTextColor: text,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: border,
      labelTextColor: text,
      loopTextColor: text,
      noteBkgColor: accentBg,
      noteBorderColor: border,
      noteTextColor: text,
      sequenceNumberColor: surface,
    },
    themeCSS: `
      .node rect, .node polygon, rect.actor, .labelBox { rx: 8px; ry: 8px; }
      .node rect, rect.actor { stroke-width: 1px; }
      .edgePath .path, .flowchart-link, .actor-line,
      .messageLine0, .messageLine1 { stroke-width: 1px; }
      .node.accent > rect, .node.accent > polygon, .node.accent > circle,
      .node.accent > path { fill: ${accentBg}; stroke: ${accent}; }
      .node.accent .nodeLabel, .node.accent span, .node.accent text { fill: ${accent}; color: ${accent}; }
      .flowchart-link.accentLine, .edgePath.accentLine > .path { stroke: ${accent}; }
    `,
  };
}

// Pinned mermaid CDN module (within CDN_ALLOWLIST). Pinned to a major so a
// breaking mermaid release can't silently change rendering; bump deliberately.
const MERMAID_CDN = "https://esm.sh/mermaid@11";

export function renderMermaidPage(doc: {
  mermaid: string;
  origin: string;
  theme?: Theme | string;
  mode?: Mode;
}): string {
  const theme =
    typeof doc.theme === "string" || doc.theme == null ? themeById(doc.theme) : doc.theme;
  const palette = doc.mode === "dark" ? theme.dark : theme.light;
  const { themeVariables, themeCSS } = mermaidThemeVars(palette, doc.mode);
  // Embed source + theme as JS literals; escape `<` so a `</script>` in the
  // diagram source can't break out of the module script.
  const enc = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
  const loader = `
import mermaid from ${enc(MERMAID_CDN)};
const src = ${enc(doc.mermaid ?? "")};
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  theme: 'base',
  themeVariables: ${enc(themeVariables)},
  themeCSS: ${enc(themeCSS)},
});
const el = document.getElementById('m');
try {
  const { svg } = await mermaid.render('mmd-svg', src);
  el.innerHTML = svg;
} catch (e) {
  // Match the old viewer fallback: a message plus the source echoed so the
  // agent can see what failed. textContent keeps the source inert.
  el.className = 'mmd-error';
  el.textContent = 'Couldn\\u2019t render diagram \\u2014 ' + (e && e.message ? e.message : 'parse error');
  const pre = document.createElement('pre');
  pre.textContent = src;
  el.appendChild(pre);
}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(doc.origin)}">
<base href="${doc.origin}/">
<style>${viewerThemeCss(theme, doc.mode)}${MERMAID_CSS}</style>
</head>
<body>
<div id="m"></div>
<script type="module">${loader}</script>
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
  // the html-surface CSP's `script-src 'unsafe-inline'`. Unknown ids are ignored.
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

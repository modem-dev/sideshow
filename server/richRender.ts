// Server-side rich-part rendering, runtime-agnostic. Renders markdown/terminal/
// code/diff parts to an HTML body + CSS so they can be served from /s/:id (real
// URL + sandbox CSP header) exactly like html parts — no POST round-trip, no
// in-memory frame store. No `node:` imports, no DOM globals: passes
// tsconfig.workers.json and runs on the Worker DO (verified on workerd; shiki
// uses the JS regex engine and @pierre/diffs the shiki-js SSR path, so neither
// needs WASM or a DOM).
//
// Each renderer returns { body, css }; renderSandboxedPart (surfacePage.ts)
// wraps body+css in the themed opaque-origin document, injecting the chrome
// theme vars (viewerThemeCss) — so this file only owns the part-specific markup
// and stylesheet, never the surrounding doc/CSP/bridge. (mermaid can't render
// without a DOM, so it stays a self-rendering CDN doc — see renderMermaidPage in
// surfacePage.ts — not a function here.)

import MarkdownIt from "markdown-it";
import { AnsiUp } from "ansi_up";
import { createHighlighter, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import {
  type FileDiffMetadata,
  getFiletypeFromFileName,
  parseDiffFromFile,
  parsePatchFiles,
  processFile,
  type SupportedLanguages,
} from "@pierre/diffs";
import { preloadFileDiff } from "@pierre/diffs/ssr";
import { preloadHighlighter } from "@pierre/diffs";
import { type Mode, THEMES, themeById } from "./themes.ts";
import type { CodePart, DiffPart, MarkdownPart, TerminalPart } from "./types.ts";

export type RenderedPart = { body: string; css: string };
export type RenderOpts = { theme?: string; mode?: Mode };

// ---------------------------------------------------------------------------
// shiki: one shared highlighter on the JS regex engine (no oniguruma WASM —
// the Workers-safe path, same engine the viewer's highlight.ts uses). Themes
// preload once; languages load on demand. Mirrors highlight.ts but server-side.
// ---------------------------------------------------------------------------

const SHIKI_DARK_RULE =
  ".shiki, .shiki span { color: var(--shiki-dark) !important; background-color: var(--shiki-dark-bg) !important; }";

// shiki emits the light theme inline + a --shiki-dark prop on every span; this
// flips to the dark theme. PINNED to the chrome-resolved scheme when mode is
// given (no media query), else follows the OS — identical to shikiSchemeCss in
// the viewer's highlight.ts (kept in lockstep so a refactor can delete that).
function shikiSchemeCss(mode?: Mode): string {
  if (mode === "dark") return SHIKI_DARK_RULE;
  if (mode === "light") return "";
  return `@media (prefers-color-scheme: dark){${SHIKI_DARK_RULE}}`;
}

// Every shiki theme any registry theme might select — preloaded once when the
// shared highlighter is created, so switching the board theme is just a
// re-highlight against an already-loaded theme (the highlighter is a singleton,
// so loading only the first-requested pair would leave every other theme
// unloaded and codeToHtml would throw on it). Mirrors the viewer's highlight.ts.
const ALL_THEMES = [...new Set(THEMES.flatMap((t) => [t.shiki.light, t.shiki.dark]))];

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ALL_THEMES,
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

// Load languages, settling silently on unknown ids (shiki throws synchronously
// on an unknown id, so each load is wrapped to turn the throw into a settled
// rejection we ignore — same as the viewer's loadLangs).
async function loadLangs(hl: Highlighter, langs: string[]): Promise<void> {
  await Promise.allSettled(langs.map(async (l) => hl.loadLanguage(l as never)));
}

function highlight(
  hl: Highlighter,
  code: string,
  lang: string,
  pair: { light: string; dark: string },
): string | null {
  if (!lang) return null;
  try {
    return hl.codeToHtml(code, { lang, themes: pair });
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shikiPair(theme?: string): { light: string; dark: string } {
  const t = themeById(theme);
  return { light: t.shiki.light, dark: t.shiki.dark };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const MD_CSS = `
body {
  margin: 0;
  padding: 4px 16px 14px;
  background: transparent;
  color: var(--text);
  font:
    14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  overflow-wrap: anywhere;
}
h1, h2, h3, h4 { line-height: 1.3; margin: 1.2em 0 0.5em; font-weight: 600; }
h1 { font-size: 1.5em; }
h2 { font-size: 1.25em; }
h3 { font-size: 1.1em; }
body > :first-child { margin-top: 0.4em; }
p, ul, ol, blockquote, table { margin: 0.5em 0; }
ul, ol { padding-left: 1.5em; }
li { margin: 0.2em 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font: 0.875em ui-monospace, monospace;
  background: var(--hover);
  padding: 0.12em 0.35em;
  border-radius: 4px;
}
pre {
  background: var(--panel);
  border: 0.5px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  overflow: auto;
}
pre code { background: none; padding: 0; font-size: 12.5px; }
blockquote {
  margin-left: 0;
  padding-left: 12px;
  border-left: 2px solid var(--border-2);
  color: var(--muted);
}
table { border-collapse: collapse; font-size: 13px; }
th, td { border: 0.5px solid var(--border); padding: 4px 8px; text-align: left; }
th { background: var(--hover); }
img { max-width: 100%; height: auto; border-radius: 6px; }
hr { border: none; border-top: 0.5px solid var(--border); margin: 1em 0; }
`;

// The languages named on fenced code blocks (```ts, ~~~python).
function fenceLangs(src: string): string[] {
  const langs = new Set<string>();
  const re = /^[ \t]*(?:```|~~~)[ \t]*([\w+#.-]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) langs.add(m[1].toLowerCase());
  return [...langs];
}

export async function renderMarkdown(
  part: MarkdownPart,
  opts: RenderOpts = {},
): Promise<RenderedPart> {
  const src = part.markdown ?? "";
  const pair = shikiPair(opts.theme);
  const hl = await getHighlighter();
  await loadLangs(hl, fenceLangs(src));

  const md = new MarkdownIt({
    html: false,
    linkify: true,
    highlight: (code, lang) => highlight(hl, code, lang, pair) ?? "",
  });
  const renderLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
    return renderLinkOpen(tokens, idx, options, env, self);
  };

  return { body: md.render(src), css: MD_CSS + shikiSchemeCss(opts.mode) };
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

const TERM_CSS = `
body { margin: 0; background: var(--term-bg); }
.term-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; background: var(--term-bar);
  border-bottom: 0.5px solid #000;
}
.term-dots { display: inline-flex; gap: 6px; }
.term-dots span { width: 11px; height: 11px; border-radius: 50%; background: #555; }
.term-dots span:nth-child(1) { background: #ff5f56; }
.term-dots span:nth-child(2) { background: #ffbd2e; }
.term-dots span:nth-child(3) { background: #27c93f; }
.term-title { font-size: 11.5px; color: var(--term-title); font-family: ui-monospace, monospace; }
.term-body {
  margin: 0; padding: 12px 14px; overflow-x: auto; white-space: pre;
  color: var(--term-fg);
  font: 12.5px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  tab-size: 8;
}
`;

function resolveCarriageReturns(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const lastCr = line.lastIndexOf("\r");
      return lastCr === -1 ? line : line.slice(lastCr + 1);
    })
    .join("\n");
}

export function renderTerminal(part: TerminalPart): RenderedPart {
  const au = new AnsiUp();
  au.use_classes = false;
  const ansi = au.ansi_to_html(resolveCarriageReturns(part.text ?? ""));
  const title = escapeHtml(part.title ?? "terminal");
  const width = part.cols ? ` style="width:${Number(part.cols)}ch"` : "";
  const body =
    `<div class="term-bar"><span class="term-dots" aria-hidden="true">` +
    `<span></span><span></span><span></span></span>` +
    `<span class="term-title">${title}</span></div>` +
    `<pre class="term-body"${width}>${ansi}</pre>`;
  return { body, css: TERM_CSS };
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

const CODE_CSS = `
body { margin: 0; padding: 0; background: transparent; }
.code-wrap { position: relative; }
.code-head {
  display: flex; align-items: center; gap: 8px; padding: 6px 12px;
  background: var(--panel); border: 0.5px solid var(--border);
  border-bottom: 0; border-radius: 8px 8px 0 0;
}
.code-filename {
  flex: 1; font: 500 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.code-lang {
  font: 400 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--faint); background: var(--hover); padding: 1px 6px;
  border-radius: 4px; text-transform: lowercase;
}
.copy-btn {
  font: 400 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--muted); background: var(--hover); border: 0.5px solid var(--border);
  border-radius: 5px; padding: 2px 9px; cursor: pointer; white-space: nowrap;
  transition: color 0.12s;
}
.copy-btn:hover { color: var(--text); }
.copy-btn.copied { color: var(--accent); }
.code-wrap:not(.code-wrap-head) .copy-btn {
  position: absolute; top: 6px; right: 8px; opacity: 0; transition: opacity 0.15s; z-index: 1;
}
.code-wrap:not(.code-wrap-head):hover .copy-btn,
.code-wrap:not(.code-wrap-head):focus-within .copy-btn { opacity: 1; }
pre.shiki, pre.plain {
  margin: 0; padding: 12px 14px; background: var(--panel);
  border: 0.5px solid var(--border); border-radius: 8px; overflow: auto;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  counter-reset: line;
}
.code-wrap.code-wrap-head pre.shiki,
.code-wrap.code-wrap-head pre.plain { border-radius: 0 0 8px 8px; }
pre.shiki code, pre.plain code { background: none; padding: 0; }
.line { counter-increment: line; display: block; min-height: 1.5em; }
.line::before {
  content: counter(line); display: inline-block; width: 2.5em; margin-right: 12px;
  color: var(--faint); text-align: right; user-select: none; -webkit-user-select: none;
}
pre.plain { color: var(--text); }
`;

function plainHtml(code: string): string {
  const lines = code.split("\n");
  return `<pre class="plain"><code>${lines
    .map((l) => `<span class="line">${escapeHtml(l)}</span>`)
    .join("")}</code></pre>`;
}

export async function renderCode(part: CodePart, opts: RenderOpts = {}): Promise<RenderedPart> {
  const code = part.code ?? "";
  const lang = part.language ?? "text";
  const lineStart = part.lineStart ?? 1;
  const pair = shikiPair(opts.theme);
  const hl = await getHighlighter();
  if (lang && lang !== "text") await loadLangs(hl, [lang]);

  const highlighted = highlight(hl, code, lang, pair);
  const pre = highlighted
    ? highlighted.replace(/\n*(<\/span>)\n*(<span class="line")/g, "$1$2")
    : plainHtml(code);
  const preWithStart =
    lineStart > 1
      ? pre.replace(/<pre\b[^>]*>/, (open) => {
          const decl = `counter-reset:line ${lineStart - 1};`;
          return /\sstyle="/.test(open)
            ? open.replace(/\sstyle="/, ` style="${decl}`)
            : open.replace(/<pre\b/, `<pre style="${decl}"`);
        })
      : pre;
  const hasHead = !!(part.title || (lang && lang !== "text"));
  const wrapClass = hasHead ? "code-wrap code-wrap-head" : "code-wrap";
  const lineEnd = lineStart + code.split("\n").length - 1;
  const range = lineStart > 1 ? `:${lineStart}-${lineEnd}` : "";
  const filename = part.title
    ? `<span class="code-filename">${escapeHtml(part.title)}${escapeHtml(range)}</span>`
    : hasHead
      ? `<span class="code-filename"></span>`
      : "";
  const langBadge =
    lang && lang !== "text" ? `<span class="code-lang">${escapeHtml(lang)}</span>` : "";
  const copyBtn = `<button class="copy-btn" onclick="__codeCopy(this)">Copy</button>`;
  const head = hasHead ? `<div class="code-head">${filename}${langBadge}${copyBtn}</div>` : copyBtn;
  const codeJs = JSON.stringify(code).replace(/</g, "\\u003c");
  const body = `<div class="${wrapClass}">${head}${preWithStart}<script>(function(){var c=${codeJs};window.__codeCopy=function(b){copyToClipboard(c);b.textContent="Copied!";b.classList.add("copied");setTimeout(function(){b.textContent="Copy";b.classList.remove("copied")},1500)}})();</script></div>`;
  return { body, css: CODE_CSS + shikiSchemeCss(opts.mode) };
}

// ---------------------------------------------------------------------------
// Diff (@pierre/diffs SSR)
// ---------------------------------------------------------------------------

const DIFF_CSS = `
body { margin: 0; padding: 0; background: transparent; font-size: 12.5px; }
diffs-container { display: block; }
diffs-container + diffs-container { border-top: 0.5px solid var(--border); }
`;

const BASE_LANGS = ["text", "json", "javascript", "typescript", "tsx", "jsx"];

function buildFileDiffs(part: DiffPart): { diffs: FileDiffMetadata[]; langs: string[] } {
  const langs = new Set<string>(BASE_LANGS);
  const diffs: FileDiffMetadata[] = [];
  if (part.patch) {
    for (const parsed of parsePatchFiles(part.patch)) {
      for (const fd of parsed.files) {
        diffs.push(fd);
        if (fd.name) langs.add(getFiletypeFromFileName(fd.name));
      }
    }
    if (diffs.length === 0) {
      const fd = processFile(part.patch);
      if (fd) diffs.push(fd);
    }
  } else if (part.files) {
    for (const f of part.files) {
      const lang = f.language ?? getFiletypeFromFileName(f.filename);
      langs.add(lang);
      diffs.push(
        parseDiffFromFile(
          { name: f.filename, contents: f.before, lang: lang as SupportedLanguages },
          { name: f.filename, contents: f.after, lang: lang as SupportedLanguages },
        ),
      );
    }
  }
  return { diffs, langs: [...langs] };
}

export async function renderDiff(part: DiffPart, opts: RenderOpts = {}): Promise<RenderedPart> {
  const t = themeById(opts.theme);
  const shiki = { dark: t.shiki.dark, light: t.shiki.light };
  const { diffs, langs } = buildFileDiffs(part);
  if (diffs.length === 0) throw new Error("No diff content.");
  await preloadHighlighter({
    themes: [shiki.dark, shiki.light],
    langs: langs as SupportedLanguages[],
    preferredHighlighter: "shiki-js",
  });
  const options = {
    diffStyle: part.layout ?? "unified",
    theme: { dark: shiki.dark, light: shiki.light },
    themeType: opts.mode === "dark" ? "dark" : "light",
    preferredHighlighter: "shiki-js",
  } as const;
  const rendered = await Promise.all(
    diffs.map((fileDiff) => preloadFileDiff({ fileDiff, options })),
  );
  const body = rendered
    .map(
      (r) =>
        `<diffs-container><template shadowrootmode="open">${r.prerenderedHTML}</template></diffs-container>`,
    )
    .join("");
  return { body, css: DIFF_CSS };
}

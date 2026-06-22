import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { CodePart as CodePartData } from "./api.ts";
import { themeById } from "../../server/themes.ts";
import { SandboxedPart } from "./SandboxedPart.tsx";
import { activeTheme } from "./theme.ts";
import { setCurrentThemes, highlight, loadLangs } from "./highlight.ts";

// Styles shipped INTO the sandbox iframe. shiki produces <pre class="shiki">
// with each line wrapped in <span class="line"> — CSS counters turn those into
// line numbers. The dark-mode rule flips shiki's dual-theme vars (same as
// MarkdownPart's fenced-code styling).
const CODE_CSS = `
body { margin: 0; padding: 0; background: transparent; }
.code-wrap { position: relative; }
.code-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--panel);
  border: 0.5px solid var(--border);
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
}
.code-filename {
  flex: 1;
  font: 500 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.code-lang {
  font: 400 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--faint);
  background: var(--hover);
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: lowercase;
}
.copy-btn {
  font: 400 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--muted);
  background: var(--hover);
  border: 0.5px solid var(--border);
  border-radius: 5px;
  padding: 2px 9px;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.12s;
}
.copy-btn:hover { color: var(--text); }
.copy-btn.copied { color: var(--accent); }
/* Floating copy button when there's no header bar. */
.code-wrap:not(.code-wrap-head) .copy-btn {
  position: absolute;
  top: 6px;
  right: 8px;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 1;
}
.code-wrap:not(.code-wrap-head):hover .copy-btn,
.code-wrap:not(.code-wrap-head):focus-within .copy-btn {
  opacity: 1;
}
pre.shiki, pre.plain {
  margin: 0;
  padding: 12px 14px;
  background: var(--panel);
  border: 0.5px solid var(--border);
  border-radius: 8px;
  overflow: auto;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  counter-reset: line;
}
.code-wrap.code-wrap-head pre.shiki,
.code-wrap.code-wrap-head pre.plain {
  border-radius: 0 0 8px 8px;
}
pre.shiki code, pre.plain code { background: none; padding: 0; }
@media (prefers-color-scheme: dark) {
  .shiki, .shiki span {
    color: var(--shiki-dark) !important;
    background-color: var(--shiki-dark-bg) !important;
  }
}
/* Line numbers via CSS counters on shiki's .line spans. min-height keeps
   empty lines from collapsing to 0 (a block with no inline content has no
   line box, so blank lines would vanish without this). */
.line {
  counter-increment: line;
  display: block;
  min-height: 1.5em;
}
.line::before {
  content: counter(line);
  display: inline-block;
  width: 2.5em;
  margin-right: 12px;
  color: var(--faint);
  text-align: right;
  user-select: none;
  -webkit-user-select: none;
}
pre.plain { color: var(--text); }
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Build the plain-text fallback (lang not loaded yet or unsupported). Wraps
// each line in <span class="line"> so CSS-counter line numbers work here too.
function plainHtml(code: string): string {
  const lines = code.split("\n");
  return `<pre class="plain"><code>${lines
    .map((l) => `<span class="line">${escapeHtml(l)}</span>`)
    .join("")}</code></pre>`;
}

export function CodePart(props: { part: CodePartData }) {
  const [html, setHtml] = createSignal("");

  const buildBody = (): string => {
    const code = props.part.code ?? "";
    const lang = props.part.language ?? "text";
    const lineStart = props.part.lineStart ?? 1;
    const highlighted = highlight(code, lang);
    // shiki's HTML has literal newlines between <span class="line"> elements
    // inside <pre>; those render as blank lines and get selected on drag.
    // Strip the inter-line whitespace so only the .line blocks remain.
    const pre = highlighted
      ? highlighted.replace(/\n*(<\/span>)\n*(<span class="line")/g, "$1$2")
      : plainHtml(code);
    // counter-reset starts the counter at lineStart-1 so the first .line
    // increments to lineStart. Merged into the <pre> as an inline style —
    // shiki emits its own `style` (and multiple classes), so prepend the
    // declaration to any existing style attribute, or add one when absent.
    const preWithStart =
      lineStart > 1
        ? pre.replace(/<pre\b[^>]*>/, (open) => {
            const decl = `counter-reset:line ${lineStart - 1};`;
            return /\sstyle="/.test(open)
              ? open.replace(/\sstyle="/, ` style="${decl}`)
              : open.replace(/<pre\b/, `<pre style="${decl}"`);
          })
        : pre;
    const hasHead = !!(props.part.title || (lang && lang !== "text"));
    const wrapClass = hasHead ? "code-wrap code-wrap-head" : "code-wrap";
    const lineEnd = lineStart + code.split("\n").length - 1;
    const range = lineStart > 1 ? `:${lineStart}-${lineEnd}` : "";
    const filename = props.part.title
      ? `<span class="code-filename">${escapeHtml(props.part.title)}${escapeHtml(range)}</span>`
      : hasHead
        ? `<span class="code-filename"></span>`
        : "";
    const langBadge =
      lang && lang !== "text" ? `<span class="code-lang">${escapeHtml(lang)}</span>` : "";
    const copyBtn = `<button class="copy-btn" onclick="__codeCopy(this)">Copy</button>`;
    const head = hasHead
      ? `<div class="code-head">${filename}${langBadge}${copyBtn}</div>`
      : copyBtn;
    // Embed the raw code as a JS string for the copy handler. Escape < so a
    // </script> in the code can't break out of the inline script tag.
    const codeJs = JSON.stringify(code).replace(/</g, "\\u003c");
    return `<div class="${wrapClass}">${head}${preWithStart}<script>(function(){var c=${codeJs};window.__codeCopy=function(b){copyToClipboard(c);b.textContent="Copied!";b.classList.add("copied");setTimeout(function(){b.textContent="Copy";b.classList.remove("copied")},1500)}})();</script></div>`;
  };

  const render = () => setHtml(buildBody());

  // Re-highlight when the board theme changes (shiki pair swap).
  createEffect(() => {
    setCurrentThemes(themeById(activeTheme()).shiki);
    render();
  });

  onMount(() => {
    let disposed = false;
    onCleanup(() => (disposed = true));
    render(); // initial paint (plain text if lang not yet loaded)
    const lang = props.part.language;
    if (lang && lang !== "text") {
      void (async () => {
        await loadLangs([lang]);
        if (!disposed) render();
      })();
    }
  });

  return <SandboxedPart class="partframe codeframe" body={html()} css={CODE_CSS} />;
}

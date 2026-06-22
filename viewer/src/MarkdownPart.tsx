import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import MarkdownIt from "markdown-it";
import type { MarkdownPart as MarkdownPartData } from "./api.ts";
import { themeById } from "../../server/themes.ts";
import { SandboxedPart } from "./SandboxedPart.tsx";
import { activeTheme, resolvedMode } from "./theme.ts";
import { setCurrentThemes, highlight, loadLangs, shikiSchemeCss } from "./highlight.ts";

// Prose styles for the rendered markdown — shipped INTO the sandbox iframe (the
// markup no longer lives in the trusted viewer DOM, so styles.css can't reach
// it). The document body is the prose root, so selectors are bare element names;
// chrome color vars come from viewerThemeCss (injected by renderSandboxedPart).
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
/* shiki dual-theme: light values render inline; the dark flip is appended at
   render time via shikiSchemeCss(resolvedMode()) — pinned to the chrome's scheme
   so this sandboxed iframe doesn't re-derive light/dark from the OS. */
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

// Dual-theme highlighting: shiki emits both themes inline (color +
// --shiki-dark), and shikiSchemeCss flips between them for the resolved scheme
// (pinned to the chrome, not the OS — see highlight.ts). Which light/dark PAIR
// is used follows the board theme (DiffPart and CodePart use the same pair so
// code blocks, diffs, and code parts read as one syntax theme). The shared
// highlighter lives in highlight.ts.

const md = new MarkdownIt({
  html: false,
  linkify: true,
  highlight: (code, lang) => highlight(code, lang) ?? "",
});

// Open links in a new tab: the markdown renders inside the viewer document
// itself, so a bare anchor click would navigate the whole board away.
const renderLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return renderLinkOpen(tokens, idx, options, env, self);
};

// The languages named on fenced code blocks (```ts, ~~~python). Aliases are
// resolved by shiki's loadLanguage; unknown names settle as rejected and are
// ignored, so the block just renders unhighlighted.
function fenceLangs(src: string): string[] {
  const langs = new Set<string>();
  const re = /^[ \t]*(?:```|~~~)[ \t]*([\w+#.-]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) langs.add(m[1].toLowerCase());
  return [...langs];
}

export function MarkdownPart(props: { part: MarkdownPartData }) {
  const [html, setHtml] = createSignal("");
  const render = () => setHtml(md.render(props.part.markdown ?? ""));

  // Re-highlight when the board theme changes: point the highlight hook at the
  // new shiki pair, then re-render. All pairs are preloaded, so this is sync.
  createEffect(() => {
    setCurrentThemes(themeById(activeTheme()).shiki);
    render();
  });

  onMount(() => {
    let disposed = false;
    onCleanup(() => (disposed = true));
    // Paint immediately (prose + any already-loaded langs), then upgrade code
    // blocks once their grammars are loaded.
    render();
    const want = fenceLangs(props.part.markdown ?? "");
    if (want.length === 0) return;
    void (async () => {
      await loadLangs(want);
      if (!disposed) render();
    })();
  });

  // The rendered HTML is a STRING built here in the trusted viewer (safe — no
  // DOM sink); SandboxedPart parses it inside an opaque-origin iframe, so even a
  // markdown-it/shiki regression can't touch the board.
  return (
    <SandboxedPart
      class="partframe mdframe"
      body={html()}
      css={MD_CSS + shikiSchemeCss(resolvedMode())}
    />
  );
}

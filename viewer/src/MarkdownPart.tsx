import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import MarkdownIt from "markdown-it";
import type { Highlighter } from "shiki";
import type { MarkdownPart as MarkdownPartData } from "./api.ts";
import { THEMES as REGISTRY, themeById } from "../../server/themes.ts";
import { activeTheme } from "./theme.ts";

// Dual-theme highlighting: shiki emits both themes inline (color +
// --shiki-dark), and a prefers-color-scheme CSS rule (styles.css) flips
// between them — so a code block never needs re-rendering when the OS theme
// changes. Which light/dark PAIR is used follows the board theme (DiffPart
// uses the same pair so code blocks and diffs read as one syntax theme).

// Every shiki theme any registry theme might select — preloaded once so a
// theme switch is just a re-highlight, no async load.
const ALL_THEMES = [...new Set(REGISTRY.flatMap((t) => [t.shiki.light, t.shiki.dark]))];

// The active light/dark shiki pair, read by the (synchronous) highlight hook.
// Updated reactively from activeTheme() in the component below.
let currentThemes = { light: REGISTRY[0].shiki.light, dark: REGISTRY[0].shiki.dark };

// One lazily-created highlighter shared across all markdown parts. Built on
// shiki's JavaScript regex engine (no oniguruma WASM) to match DiffPart's
// "shiki-js" — the grammars are already in the bundle via @pierre/diffs, so
// this adds no meaningful weight. Languages load on demand (see loadLangs).
let highlighter: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighter }, { createJavaScriptRegexEngine }] = await Promise.all([
        import("shiki"),
        import("shiki/engine/javascript"),
      ]);
      highlighter = await createHighlighter({
        themes: ALL_THEMES,
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
      return highlighter;
    })();
  }
  return highlighterPromise;
}

// markdown-it's highlight hook is synchronous, so it can only highlight
// languages already loaded into the shared highlighter; unknown/unloaded langs
// return "" and fall back to markdown-it's default escaped <pre><code>. We
// preload a part's fence languages (loadLangs) before re-rendering.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  highlight: (code, lang) => {
    if (highlighter && lang) {
      try {
        return highlighter.codeToHtml(code, { lang, themes: currentThemes });
      } catch {
        // lang not loaded or unsupported — fall through to plain escaping
      }
    }
    return "";
  },
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
    currentThemes = themeById(activeTheme()).shiki;
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
      const hl = await getHighlighter();
      // loadLanguage throws *synchronously* on an unknown id, so wrap each call
      // in an async fn — that turns the throw into a settled rejection we ignore.
      await Promise.allSettled(want.map(async (l) => hl.loadLanguage(l as never)));
      if (!disposed) render();
    })();
  });

  // eslint-disable-next-line solid/no-innerhtml -- sanitized: html:false above
  return <div class="mdpart" innerHTML={html()}></div>;
}

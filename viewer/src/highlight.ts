import type { Highlighter } from "shiki";
import { type Mode, THEMES as REGISTRY } from "../../server/themes.ts";

export type ShikiPair = { light: string; dark: string };

// shiki emits dual-theme output: the light theme inline (`color:`) plus a
// `--shiki-dark` custom prop on every span. This rule overrides color/background
// with those vars to render the dark theme. Code/markdown parts render inside a
// sandboxed iframe, so — like the surface tokens — the flip is PINNED to the
// scheme the chrome resolved when a mode is given (no media query), keeping the
// frame in lockstep with the chrome instead of re-deriving from the OS across
// the frame boundary. Without a mode it follows the OS (self-hosted default).
const SHIKI_DARK_RULE =
  ".shiki, .shiki span { color: var(--shiki-dark) !important; background-color: var(--shiki-dark-bg) !important; }";

export function shikiSchemeCss(mode?: Mode): string {
  if (mode === "dark") return SHIKI_DARK_RULE;
  if (mode === "light") return "";
  return `@media (prefers-color-scheme: dark){${SHIKI_DARK_RULE}}`;
}

// Every shiki theme any registry theme might select — preloaded once so a
// theme switch is just a re-highlight, no async load.
const ALL_THEMES = [...new Set(REGISTRY.flatMap((t) => [t.shiki.light, t.shiki.dark]))];

// The active light/dark shiki pair, read by the synchronous highlight function.
// Updated reactively from MarkdownPart/CodePart via setCurrentThemes().
let currentThemes: ShikiPair = {
  light: REGISTRY[0].shiki.light,
  dark: REGISTRY[0].shiki.dark,
};

export function setCurrentThemes(pair: ShikiPair): void {
  currentThemes = pair;
}

// One lazily-created highlighter shared across all parts that highlight code
// (MarkdownPart fenced blocks, CodePart). Built on shiki's JavaScript regex
// engine (no oniguruma WASM) — the grammars are already in the bundle via
// @pierre/diffs, so this adds no meaningful weight. Languages load on demand.
let highlighter: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
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

// Synchronous highlight — returns shiki's dual-theme HTML string, or null if
// the highlighter or language isn't loaded yet. Callers fall back to plain
// escaped text and re-render after loadLangs() resolves.
export function highlight(code: string, lang: string): string | null {
  if (highlighter && lang) {
    try {
      return highlighter.codeToHtml(code, { lang, themes: currentThemes });
    } catch {
      return null;
    }
  }
  return null;
}

// Load languages async; settles silently on unknown ids (shiki's loadLanguage
// throws synchronously on an unknown id, so each call is wrapped in an async
// fn that turns the throw into a settled rejection we ignore).
export async function loadLangs(langs: string[]): Promise<void> {
  const hl = await getHighlighter();
  await Promise.allSettled(langs.map(async (l) => hl.loadLanguage(l as never)));
}

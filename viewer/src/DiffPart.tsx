import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
  CodeView,
  type CodeViewItem,
  type FileDiffMetadata,
  getFiletypeFromFileName,
  parseDiffFromFile,
  parsePatchFiles,
  preloadHighlighter,
  processFile,
  type SupportedLanguages,
} from "@pierre/diffs";
import type { DiffPart as DiffPartData } from "./api.ts";
import { themeById } from "../../server/themes.ts";
import { activeTheme } from "./theme.ts";

// The shiki light/dark pair follows the board theme (kept identical to
// MarkdownPart so a diff and a fenced code block read as one syntax theme).
const shikiPair = () => {
  const t = themeById(activeTheme());
  return { dark: t.shiki.dark, light: t.shiki.light };
};

// The viewer theme is purely prefers-color-scheme driven (see styles.css), so
// the diff follows the OS/browser scheme and re-renders when it flips.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const [isDark, setIsDark] = createSignal(darkQuery.matches);
darkQuery.addEventListener("change", (e) => setIsDark(e.matches));

// A small base set of langs the highlighter always loads; the rest are
// inferred from the part's filenames. preloadHighlighter only loads what we
// ask for, so we keep this lean to avoid pulling in every shiki grammar.
const BASE_LANGS = ["text", "json", "javascript", "typescript", "tsx", "jsx"];

// Turn a DiffPart into one FileDiffMetadata per file: prefer an explicit
// unified patch, else build a diff from each before/after pair.
function buildFileDiffs(part: DiffPartData): { diffs: FileDiffMetadata[]; langs: string[] } {
  const langs = new Set<string>(BASE_LANGS);
  const diffs: FileDiffMetadata[] = [];

  if (part.patch) {
    // parsePatchFiles returns one ParsedPatch per commit; each carries a
    // files[] of FileDiffMetadata. Flatten them into a flat per-file list.
    for (const parsed of parsePatchFiles(part.patch)) {
      for (const fd of parsed.files) {
        diffs.push(fd);
        if (fd.name) langs.add(getFiletypeFromFileName(fd.name));
      }
    }
    // Some patches (a bare hunk with no `diff --git` header) yield no files
    // from parsePatchFiles; fall back to treating the whole text as one file.
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

export function DiffPart(props: { part: DiffPartData }) {
  let container!: HTMLDivElement;
  const [error, setError] = createSignal<string | null>(null);
  let cv: CodeView | undefined;

  onMount(() => {
    let disposed = false;

    const setup = async () => {
      try {
        const { diffs, langs } = buildFileDiffs(props.part);
        if (diffs.length === 0) {
          setError("No diff content.");
          return;
        }
        const shiki = shikiPair();
        await preloadHighlighter({
          themes: [shiki.dark, shiki.light],
          langs: langs as SupportedLanguages[],
          preferredHighlighter: "shiki-js",
        });
        if (disposed) return;

        const items: CodeViewItem[] = diffs.map((fileDiff, i) => ({
          id: `f${i}`,
          type: "diff",
          fileDiff,
        }));

        // CodeView owns the core/grid CSS + layout managers — FileDiff alone
        // does not inject them, so the diff must be driven through CodeView.
        cv = new CodeView({
          diffStyle: props.part.layout ?? "unified",
          theme: { dark: shiki.dark, light: shiki.light },
          themeType: isDark() ? "dark" : "light",
          preferredHighlighter: "shiki-js",
        });
        cv.setup(container);
        cv.setItems(items);
        cv.render(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not render diff.");
      }
    };

    void setup();

    // Re-theme in place when the color scheme flips OR the board theme changes.
    // A board-theme switch needs the new shiki pair loaded first; the scheme
    // flip reuses already-loaded themes, but preloadHighlighter is idempotent.
    createEffect(() => {
      const dark = isDark();
      const shiki = shikiPair();
      if (!cv) return;
      const current = cv;
      void (async () => {
        await preloadHighlighter({
          themes: [shiki.dark, shiki.light],
          langs: [],
          preferredHighlighter: "shiki-js",
        });
        if (disposed || current !== cv) return;
        current.setOptions({
          diffStyle: props.part.layout ?? "unified",
          theme: { dark: shiki.dark, light: shiki.light },
          themeType: dark ? "dark" : "light",
          preferredHighlighter: "shiki-js",
        });
        current.onThemeChange();
        current.render(true);
      })();
    });

    onCleanup(() => {
      disposed = true;
      try {
        cv?.cleanUp();
      } catch {
        // ignore teardown errors
      }
      cv = undefined;
    });
  });

  return (
    <div class="diffpart">
      {error() ? (
        <div class="diff-error">Couldn't render diff — {error()}</div>
      ) : (
        <div ref={(el) => (container = el)} class="diff-view"></div>
      )}
    </div>
  );
}

import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
  type FileDiffMetadata,
  getFiletypeFromFileName,
  parseDiffFromFile,
  parsePatchFiles,
  preloadHighlighter,
  processFile,
  type SupportedLanguages,
} from "@pierre/diffs";
import { preloadFileDiff } from "@pierre/diffs/ssr";
import type { DiffPart as DiffPartData } from "./api.ts";
import { themeById } from "../../server/themes.ts";
import { SandboxedPart } from "./SandboxedPart.tsx";
import { activeTheme } from "./theme.ts";

// Wrapper styles for the sandbox iframe. Each file's diff is a @pierre/diffs SSR
// fragment mounted in its OWN declarative shadow root (it ships its own scoped
// stylesheet, keyed off :host), so the iframe body only spaces the files.
const DIFF_CSS = `
body { margin: 0; padding: 0; background: transparent; font-size: 12.5px; }
diffs-container { display: block; }
diffs-container + diffs-container { border-top: 0.5px solid var(--border); }
`;

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
  const [error, setError] = createSignal<string | null>(null);
  const [body, setBody] = createSignal<string | null>(null);

  onMount(() => {
    let disposed = false;
    onCleanup(() => (disposed = true));

    // Render to an HTML STRING (per file, via the SSR API) whenever the board
    // theme or color scheme changes — string building is not a DOM sink, so
    // doing it in the trusted viewer is safe; SandboxedPart parses it inside an
    // opaque-origin iframe. Each file's fragment goes in its own declarative
    // shadow root so its scoped :host stylesheet applies.
    createEffect(() => {
      const dark = isDark();
      const shiki = shikiPair();
      void (async () => {
        try {
          const { diffs, langs } = buildFileDiffs(props.part);
          if (diffs.length === 0) {
            setError("No diff content.");
            return;
          }
          await preloadHighlighter({
            themes: [shiki.dark, shiki.light],
            langs: langs as SupportedLanguages[],
            preferredHighlighter: "shiki-js",
          });
          if (disposed) return;
          const options = {
            diffStyle: props.part.layout ?? "unified",
            theme: { dark: shiki.dark, light: shiki.light },
            themeType: dark ? "dark" : "light",
            preferredHighlighter: "shiki-js",
          } as const;
          const rendered = await Promise.all(
            diffs.map((fileDiff) => preloadFileDiff({ fileDiff, options })),
          );
          if (disposed) return;
          setError(null);
          setBody(
            rendered
              .map(
                (r) =>
                  `<diffs-container><template shadowrootmode="open">${r.prerenderedHTML}</template></diffs-container>`,
              )
              .join(""),
          );
        } catch (err) {
          if (!disposed) setError(err instanceof Error ? err.message : "Could not render diff.");
        }
      })();
    });
  });

  return (
    <div class="diffpart">
      {error() ? (
        <div class="diff-error">Couldn't render diff — {error()}</div>
      ) : (
        <SandboxedPart class="partframe diffframe" body={body() ?? ""} css={DIFF_CSS} />
      )}
    </div>
  );
}

// One surface, as the file it came from — what the viewer's share menu offers
// as "Download diagram.mmd" and what GET
// /api/posts/:id/surfaces/:target/raw serves so the CLI/HTTP tiers can have it
// too.
//
// The rule is RAW SOURCE, not rendered output: a mermaid surface downloads its
// `.mmd` source (re-editable), never the rendered SVG; a diff downloads a
// `.patch` you can `git apply`. The rendered form already has a door — "Open as
// image" — and a picture of a diagram is not a diagram.
//
// Runtime-agnostic (no `node:` imports, no DOM): the Worker DO serves this route
// as well, and the viewer imports `surfaceDownloadName` so the menu row can be
// labelled with the exact filename the download will have — one naming rule, not
// two that drift.
//
// Like postMarkdown.ts this reads a STORED post, so it sees full surface bodies;
// the viewer's hydrated posts deliberately omit sandboxed surface content (see
// apiViews.ts), which is why the bytes are assembled here and not in the viewer.
import { unifiedDiff } from "./postMarkdown.ts";
import type {
  CodeSurface,
  DiffSurface,
  HtmlSurface,
  ImageSurface,
  JsonSurface,
  MarkdownSurface,
  MermaidSurface,
  Surface,
  TerminalSurface,
  TraceSurface,
} from "./types.ts";

// What a surface downloads as. `inline` carries the bytes; `asset` defers to the
// stored blob at /a/:id (image and file-backed trace surfaces are by reference —
// re-encoding them here would be a copy, not a download). An asset's `filename`
// is only a fallback: the stored asset usually carries the name it was uploaded
// under, which beats anything derived, and only the store can see it.
export type SurfaceDownload =
  | { via: "inline"; filename: string; contentType: string; body: string }
  | { via: "asset"; filename: string; assetId: string };

// The little a filename needs to know about a surface: its kind, and — for a
// code surface — the title and language its extension comes from. Loose on
// purpose so the viewer can pass a hydrated surface (which has no body) and the
// server a stored one.
export interface NamedSurface {
  kind: Surface["kind"];
  title?: string;
  language?: string;
}

// Extension per kind. `code` is the exception — its extension comes from the
// surface's own filename or language, so it isn't listed here.
const KIND_EXTENSIONS = {
  html: "html",
  markdown: "md",
  // `.mmd` is mermaid's own convention (mermaid-cli reads it); there is no
  // registered media type, so it travels as plain text.
  mermaid: "mmd",
  diff: "patch",
  terminal: "txt",
  json: "json",
  trace: "json",
  // Asset-backed: a placeholder only. The route prefers the stored asset's own
  // filename, which is the one the uploader chose and the only one that knows
  // whether these bytes are a png or a jpeg.
  image: "png",
} as const satisfies Omit<Record<Surface["kind"], string>, "code">;

// Content types for downloads. Deliberately inert: every entry is a type no
// browser will execute, and `html` is absent on purpose — agent-authored markup
// is served as application/octet-stream so that even a mis-handled response can
// never run as a live document on the workspace origin. Same stance as the asset
// route's ATTACH_SAFE_TYPES (see app.ts).
const KIND_CONTENT_TYPES: Partial<Record<Surface["kind"], string>> = {
  markdown: "text/markdown; charset=utf-8",
  mermaid: "text/plain; charset=utf-8",
  diff: "text/plain; charset=utf-8",
  terminal: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  trace: "application/json; charset=utf-8",
};

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

// Common shiki language ids → the extension a developer expects back. Only the
// ones whose extension isn't just the id itself; everything else falls through
// to the language id, which is right far more often than it is wrong (ts, js,
// py… all name their own extension) and harmless when it isn't.
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  ruby: "rb",
  rust: "rs",
  markdown: "md",
  shellscript: "sh",
  shell: "sh",
  bash: "sh",
  yaml: "yml",
  csharp: "cs",
  kotlin: "kt",
  golang: "go",
  text: "txt",
  plaintext: "txt",
};

// A filesystem-safe stem from a post title. Anything that isn't a word
// character becomes a single dash, so "Auth refactor: step 2" → "auth-refactor-step-2".
// Falls back to "post" when a title is empty or entirely punctuation, and is
// capped so a rambling title can't produce a name the OS refuses.
const MAX_STEM = 48;

export function filenameStem(title: string | undefined): string {
  const stem = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_STEM)
    .replace(/-+$/, "");
  return stem || "post";
}

// A code surface's title is usually a filename ("api.ts"), and a filename the
// agent chose beats anything derived — but only when it really is one. A title
// like "The parser, annotated" has no extension and would download as a file the
// OS can't open, so it degrades to the title-derived stem plus the language's
// extension.
function codeFilename(surface: NamedSurface, stem: string, index: number): string {
  const title = surface.title?.trim();
  if (title && /^[\w.\- ]+\.[a-z0-9]+$/i.test(title)) return title.replace(/[^\w.-]/g, "_");
  const language = surface.language?.toLowerCase() ?? "";
  const ext = LANGUAGE_EXTENSIONS[language] ?? (/^[a-z0-9]+$/.test(language) ? language : "txt");
  return `${stem}${suffix(index)}.${ext}`;
}

// Multi-surface posts need the surfaces told apart, so every surface after the
// first carries its 1-based position. A single-surface post — the common case,
// and the one worth keeping tidy — downloads as a bare `title.md`.
const suffix = (index: number) => (index === 0 ? "" : `-${index + 1}`);

// The filename a surface downloads as. Exported on its own because the viewer
// labels its menu row with it (and has only the hydrated surface, no body).
export function surfaceDownloadName(
  surface: NamedSurface,
  index: number,
  postTitle?: string,
): string {
  const stem = filenameStem(postTitle);
  if (surface.kind === "code") return codeFilename(surface, stem, index);
  const ext = KIND_EXTENSIONS[surface.kind as keyof typeof KIND_EXTENSIONS] ?? "txt";
  return `${stem}${suffix(index)}.${ext}`;
}

function jsonBody(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2) ?? "null";
  } catch {
    // A cycle can't reach a stored surface (it arrived as JSON), but the store
    // is not the only caller — degrade instead of throwing.
    return String(data);
  }
}

// A diff surface sent as before/after file pairs has no patch of its own, so
// build one. Same fallback postMarkdown uses, and the reason `unifiedDiff` is
// exported: the point of a `.patch` download is that `git apply` takes it.
function diffBody(surface: DiffSurface): string | null {
  if (surface.patch) return surface.patch;
  if (!surface.files?.length) return null;
  const patch = surface.files.map((f) => unifiedDiff(f.filename, f.before, f.after)).join("");
  return patch || null;
}

// The bytes (or the asset reference) for one surface, or null when there is
// nothing to download — an empty body, a diff with neither patch nor files, an
// inline trace with no steps, or a kind this build doesn't know. Callers turn
// null into a 404 rather than serving a zero-byte file.
export function surfaceDownload(
  surface: Surface,
  index: number,
  postTitle?: string,
): SurfaceDownload | null {
  const filename = surfaceDownloadName(surface, index, postTitle);
  const contentType = KIND_CONTENT_TYPES[surface.kind] ?? FALLBACK_CONTENT_TYPE;
  const inline = (body: string | null | undefined): SurfaceDownload | null =>
    body ? { via: "inline", filename, contentType, body } : null;

  switch (surface.kind) {
    case "html":
      return inline((surface as HtmlSurface).html);
    case "markdown":
      return inline((surface as MarkdownSurface).markdown);
    case "mermaid":
      return inline((surface as MermaidSurface).mermaid);
    case "code":
      return inline((surface as CodeSurface).code);
    // Raw, ANSI and all: the escapes ARE the original output, and a terminal
    // replays them. postMarkdown strips them because a markdown fence can't
    // render them; a file has no such excuse.
    case "terminal":
      return inline((surface as TerminalSurface).text);
    case "diff":
      return inline(diffBody(surface as DiffSurface));
    case "json":
      return inline(jsonBody((surface as JsonSurface).data));
    case "image": {
      const { assetId } = surface as ImageSurface;
      return assetId ? { via: "asset", filename, assetId } : null;
    }
    case "trace": {
      const trace = surface as TraceSurface;
      // The uploaded file is the real artifact when there is one; inline steps
      // are the smaller, structured form and download as the JSON they are.
      if (trace.assetId) return { via: "asset", filename, assetId: trace.assetId };
      return trace.steps?.length ? inline(jsonBody(trace.steps)) : null;
    }
    default:
      return null;
  }
}

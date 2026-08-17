// Flatten a post to portable markdown — what the viewer's "copy as markdown"
// share action puts on the clipboard, and what GET /api/posts/:id/markdown
// serves so the CLI/HTTP tiers can have it too.
//
// Runtime-agnostic (no `node:` imports, no DOM): the Worker DO serves this route
// as well. It reads a stored post, so it sees full surface bodies — the viewer's
// hydrated posts deliberately omit sandboxed surface content (see apiViews.ts),
// which is exactly why this lives on the server rather than in the viewer.
//
// Each kind flattens the honest way: text kinds become fenced blocks, an image
// becomes an image link, and `html` — markup with no faithful markdown form —
// degrades to a link back to the surface rather than dumping its source. Unknown
// and by-reference kinds take that same link fallback.
import type {
  CodeSurface,
  DiffSurface,
  ImageSurface,
  JsonSurface,
  MarkdownSurface,
  MermaidSurface,
  Post,
  Surface,
  TerminalSurface,
} from "./types.ts";

export interface PostMarkdownOptions {
  // Absolute permalink to the post (`…/p/:id`). Surface links append `?part=N`
  // (the legacy wire key the route still takes). Omit for a link-free document.
  postUrl?: string;
  // Absolute base an asset path hangs off (`…/a/:id`), i.e. origin + base path.
  // Relative `/a/:id` links are useless once pasted elsewhere, so an image
  // surface without this degrades to its alt text.
  assetBase?: string;
}

// A post the flattener can read. Loosened from `Post` so a single version out
// of `history` (which carries no id/timestamps) can be flattened too.
export type MarkdownablePost = Pick<Post, "title" | "surfaces"> &
  Partial<Pick<Post, "version" | "updatedAt">>;

// Fence long enough to survive backticks in the content: markdown needs the
// opening fence to be longer than any backtick run inside it.
function fence(body: string, info: string): string {
  const longest = [...body.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${info}\n${body.replace(/\n+$/, "")}\n${ticks}`;
}

// ANSI escapes carry no meaning in a markdown code block — strip SGR and the
// rest of the CSI/OSC family so pasted terminal output reads as plain text.
// oxlint-disable no-control-regex -- matching the escapes is the whole point
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "") // OSC (titles, hyperlinks)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI (SGR colors, cursor moves)
    .replace(/\u001b[@-Z\\-_]/g, ""); // two-character escapes
}
// oxlint-enable no-control-regex

// UTC to the minute. A copied document outlives "2 minutes ago", so the stamp
// has to be absolute — but seconds are noise for a human reading a paste.
function stamp(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function surfaceUrl(opts: PostMarkdownOptions, index: number): string | null {
  if (!opts.postUrl) return null;
  // `?part=` is the legacy wire query key for a surface index — kept byte-identical.
  return `${opts.postUrl}?part=${index}`;
}

const KIND_LABELS: Record<string, string> = {
  html: "Html surface",
  trace: "Trace surface",
};

// Kinds with no markdown form (html) and by-reference kinds (trace) point back
// at the surface instead. Also the forward-compat path: a kind this build
// doesn't know still produces a working link rather than nothing.
function linkFallback(surface: Surface, index: number, opts: PostMarkdownOptions): string {
  const label = KIND_LABELS[surface.kind] ?? `${surface.kind} surface`;
  const url = surfaceUrl(opts, index);
  return url ? `[${label} — open in sideshow](${url})` : `_${label} ${index + 1}_`;
}

function codeBlock(surface: CodeSurface): string {
  const body = surface.code ?? "";
  const heading = codeHeading(surface, body);
  return `${heading}${fence(body, surface.language ?? "text")}`;
}

// A code surface's title (usually a filename) becomes a bold line above the
// block; an excerpt with `lineStart` says which lines it is, so the pasted block
// keeps the context the viewer shows in its gutter.
function codeHeading(surface: CodeSurface, body: string): string {
  if (!surface.title && surface.lineStart === undefined) return "";
  const name = surface.title ? `\`${surface.title}\`` : "Excerpt";
  const start = surface.lineStart;
  if (start === undefined) return `**${name}**\n\n`;
  // splitLines, not a raw split: a body ending in a newline is not one line longer.
  const end = start + Math.max(1, splitLines(body).length) - 1;
  return `**${name}** (lines ${start}–${end})\n\n`;
}

function imageBlock(surface: ImageSurface, opts: PostMarkdownOptions): string {
  const alt = surface.alt ?? surface.caption ?? "image";
  const caption = surface.caption ? `\n\n_${surface.caption}_` : "";
  if (!opts.assetBase) return `_${alt}_`;
  return `![${alt}](${opts.assetBase}/a/${surface.assetId})${caption}`;
}

function diffBlock(surface: DiffSurface): string | null {
  if (surface.patch) return fence(surface.patch, "diff");
  if (!surface.files?.length) return null;
  const patch = surface.files.map((f) => unifiedDiff(f.filename, f.before, f.after)).join("");
  return patch ? fence(patch, "diff") : null;
}

function terminalBlock(surface: TerminalSurface): string {
  const heading = surface.title ? `**${surface.title}**\n\n` : "";
  return `${heading}${fence(stripAnsi(surface.text ?? ""), "console")}`;
}

function jsonBlock(surface: JsonSurface): string {
  let body: string;
  try {
    body = JSON.stringify(surface.data, null, 2) ?? "null";
  } catch {
    // A cycle can't reach a stored surface (it arrived as JSON), but the store
    // is not the only caller — degrade instead of throwing out the whole post.
    body = String(surface.data);
  }
  return fence(body, "json");
}

export function surfaceToMarkdown(
  surface: Surface,
  index: number,
  opts: PostMarkdownOptions = {},
): string {
  switch (surface.kind) {
    case "markdown":
      return (surface as MarkdownSurface).markdown?.trim() ?? "";
    case "code":
      return codeBlock(surface as CodeSurface);
    case "diff":
      return diffBlock(surface as DiffSurface) ?? linkFallback(surface, index, opts);
    case "terminal":
      return terminalBlock(surface as TerminalSurface);
    case "json":
      return jsonBlock(surface as JsonSurface);
    case "mermaid":
      // A ```mermaid fence renders as a diagram on GitHub and in most markdown
      // viewers, so the diagram survives the paste rather than becoming source.
      return fence((surface as MermaidSurface).mermaid ?? "", "mermaid");
    case "image":
      return imageBlock(surface as ImageSurface, opts);
    default:
      return linkFallback(surface, index, opts);
  }
}

export function postToMarkdown(post: MarkdownablePost, opts: PostMarkdownOptions = {}): string {
  const meta = [
    opts.postUrl ? `[View in sideshow](${opts.postUrl})` : null,
    post.version && post.version > 1 ? `v${post.version}` : null,
    post.updatedAt ? stamp(post.updatedAt) : null,
  ].filter(Boolean);
  const blocks = [
    `## ${post.title}`,
    meta.length ? meta.join(" · ") : null,
    ...post.surfaces.map((surface, i) => surfaceToMarkdown(surface, i, opts).trim()),
  ].filter((block): block is string => !!block);
  return blocks.join("\n\n") + "\n";
}

// --- unified diff, for a diff surface sent as before/after file pairs --------
// The `files` form is the documented fallback for agents without a patch, so
// this is the fallback's fallback: enough of a unified diff to paste and read —
// and to apply. `git apply` is unforgiving, so the end-of-file newline is
// tracked as carefully as the lines themselves. Deliberately small and
// dependency-free: @pierre/diffs renders the real view in the viewer, and
// pulling its SSR path in here would drag a highlighter into a text transform.

const DIFF_CONTEXT = 3;
// Above this many changed lines on either side, the middle is emitted as one
// wholesale replacement instead of a line-matched diff. Keeps the O(n·m) matrix
// off the heap for large files; a huge rewrite reads the same either way.
const DIFF_MAX_MATRIX = 1500;
const NO_EOF_MARKER = "\\ No newline at end of file";

// One line of a file, plus whether it is a last line with no newline after it.
// That flag is part of the line's IDENTITY, not decoration: "c" and "c" with no
// trailing newline are different content, so they must not match each other in
// the LCS — otherwise adding a final newline reads as an empty diff.
type Entry = { line: string; noEof: boolean };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function entries(text: string): Entry[] {
  const lines = splitLines(text);
  const noEof = lines.length > 0 && !text.endsWith("\n");
  return lines.map((line, i) => ({ line, noEof: noEof && i === lines.length - 1 }));
}

const sameEntry = (a: Entry, b: Entry) => a.line === b.line && a.noEof === b.noEof;

type Op = { tag: " " | "-" | "+"; line: string; noEof: boolean };

const op = (tag: Op["tag"], entry: Entry): Op => ({ tag, line: entry.line, noEof: entry.noEof });

function diffOps(before: Entry[], after: Entry[]): Op[] {
  let head = 0;
  while (head < before.length && head < after.length && sameEntry(before[head], after[head]))
    head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    sameEntry(before[before.length - 1 - tail], after[after.length - 1 - tail])
  )
    tail++;

  const midBefore = before.slice(head, before.length - tail);
  const midAfter = after.slice(head, after.length - tail);
  const ops: Op[] = before.slice(0, head).map((entry) => op(" ", entry));

  if (midBefore.length > DIFF_MAX_MATRIX || midAfter.length > DIFF_MAX_MATRIX) {
    ops.push(...midBefore.map((entry) => op("-", entry)));
    ops.push(...midAfter.map((entry) => op("+", entry)));
  } else {
    ops.push(...lcsOps(midBefore, midAfter));
  }
  ops.push(...before.slice(before.length - tail).map((entry) => op(" ", entry)));
  return ops;
}

function lcsOps(before: Entry[], after: Entry[]): Op[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j] = length of the longest common subsequence of before[i..], after[j..].
  // Int32Array rows: the matrix is the one allocation here worth being careful
  // about (DIFF_MAX_MATRIX bounds it, but that is still up to ~2.25M cells).
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = sameEntry(before[i], after[j])
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sameEntry(before[i], after[j])) {
      ops.push(op(" ", before[i]));
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push(op("-", before[i]));
      i++;
    } else {
      ops.push(op("+", after[j]));
      j++;
    }
  }
  while (i < n) ops.push(op("-", before[i++]));
  while (j < m) ops.push(op("+", after[j++]));
  return ops;
}

// A side that contributes no lines to a hunk is numbered from the line it comes
// AFTER, so a pure insertion into an empty file is `-0,0` — not `-1,0`.
const hunkRange = (start: number, count: number) => `${count === 0 ? start - 1 : start},${count}`;

export function unifiedDiff(filename: string, before: string, after: string): string {
  if (before === after) return "";
  const ops = diffOps(entries(before), entries(after));
  const hunks: string[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  let cursor = 0;
  while (cursor < ops.length) {
    if (ops[cursor].tag === " ") {
      beforeLine++;
      afterLine++;
      cursor++;
      continue;
    }
    // Walk to the end of this run of changes, absorbing short stretches of
    // context so two nearby edits land in one hunk rather than two.
    let end = cursor;
    for (let i = cursor; i < ops.length; i++) {
      if (ops[i].tag !== " ") end = i;
      else if (i - end > DIFF_CONTEXT * 2) break;
    }
    const start = Math.max(0, cursor - DIFF_CONTEXT);
    const stop = Math.min(ops.length, end + DIFF_CONTEXT + 1);
    const beforeStart = beforeLine - (cursor - start);
    const afterStart = afterLine - (cursor - start);
    const body: string[] = [];
    let beforeCount = 0;
    let afterCount = 0;
    for (let i = start; i < stop; i++) {
      const o = ops[i];
      body.push(o.tag + o.line);
      // The marker annotates the line above it and counts toward neither side.
      if (o.noEof) body.push(NO_EOF_MARKER);
      if (o.tag !== "+") beforeCount++;
      if (o.tag !== "-") afterCount++;
    }
    hunks.push(
      `@@ -${hunkRange(beforeStart, beforeCount)} +${hunkRange(afterStart, afterCount)} @@\n${body.join("\n")}\n`,
    );
    for (let i = cursor; i < stop; i++) {
      if (ops[i].tag !== "+") beforeLine++;
      if (ops[i].tag !== "-") afterLine++;
    }
    cursor = stop;
  }
  if (!hunks.length) return "";
  return `--- a/${filename}\n+++ b/${filename}\n${hunks.join("")}`;
}

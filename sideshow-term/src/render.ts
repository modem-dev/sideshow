// STML -> opentui. Turns a parsed STML tree into a tree of opentui
// Renderables. Runs on Bun only (opentui's native core needs Bun's FFI).
//
// Two structural ideas mirror HTML:
//   * inline vs block. Text and inline tags (<b>, <color>…) flow into a single
//     TextRenderable; block tags (<box>, <row>, <list>…) become their own
//     Renderable. Bare text inside a block container is auto-wrapped, so
//     `<box>hello</box>` just works.
//   * tolerant rendering. An unknown tag or bad color is recorded in `errors`
//     and skipped/degraded rather than thrown — a snippet always renders.

import {
  ASCIIFontRenderable,
  type BaseRenderable,
  bg,
  bold,
  BoxRenderable,
  dim,
  fg,
  fonts,
  InputRenderable,
  isValidBorderStyle,
  italic,
  type RenderContext,
  SelectRenderable,
  strikethrough,
  StyledText,
  stringToStyledText,
  TextRenderable,
  underline,
} from "@opentui/core";
import {
  decodeEntities,
  DEFAULT_PARSE_LIMITS,
  parse,
  sanitizeTerminalText,
  type STMLElement,
  type STMLNode,
} from "./parse.ts";
import { resolveColor } from "./theme.ts";

type Chunk = ReturnType<typeof bold>;

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  strike?: boolean;
}

const MAX_RENDER_ERRORS = DEFAULT_PARSE_LIMITS.maxErrors;

const INLINE = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "dim",
  "muted",
  "s",
  "strike",
  "del",
  "c",
  "color",
  "span",
  "a",
  "link",
  "kbd",
  "badge",
  "br",
]);

const truthyAttr = (v: string | undefined) =>
  v === undefined || v === "" || v === "true" || v === "yes" || v === "on";

const mergeStyle = (base: Style, over: Style): Style => ({ ...base, ...over });

function attrStyle(attrs: Record<string, string>): Style {
  const s: Style = {};
  if (attrs.fg ?? attrs.color) s.fg = attrs.fg ?? attrs.color;
  if (attrs.bg) s.bg = attrs.bg;
  if ("bold" in attrs) s.bold = truthyAttr(attrs.bold);
  if ("italic" in attrs) s.italic = truthyAttr(attrs.italic);
  if ("underline" in attrs) s.underline = truthyAttr(attrs.underline);
  if ("dim" in attrs) s.dim = truthyAttr(attrs.dim);
  if ("strike" in attrs) s.strike = truthyAttr(attrs.strike);
  return s;
}

function inlineStyle(tag: string, attrs: Record<string, string>): Style {
  switch (tag) {
    case "b":
    case "strong":
      return { bold: true };
    case "i":
    case "em":
      return { italic: true };
    case "u":
      return { underline: true };
    case "s":
    case "strike":
    case "del":
      return { strike: true };
    case "dim":
    case "muted":
      return { dim: true };
    case "kbd":
      return { bg: "subtle", fg: "heading" };
    case "badge":
      return { bg: attrs.color ?? attrs.bg ?? "accent", fg: attrs.fg ?? "#0b0b0b", bold: true };
    case "a":
    case "link":
      return { fg: "accent", underline: true };
    default:
      return attrStyle(attrs);
  }
}

const collapseWs = (s: string) => s.replace(/\s+/g, " ");

function recordRenderError(errors: string[], message: string): void {
  if (errors.length < MAX_RENDER_ERRORS) {
    errors.push(message);
  } else if (errors.length === MAX_RENDER_ERRORS) {
    errors.push("further render notes omitted");
  }
}

function styledChunk(text: string, style: Style, errors: string[]): Chunk {
  let input: string | Chunk = text;
  if (style.bold) input = bold(input);
  if (style.italic) input = italic(input);
  if (style.underline) input = underline(input);
  if (style.dim) input = dim(input);
  if (style.strike) input = strikethrough(input);
  if (style.fg) {
    const c = resolveColor(style.fg);
    if (c) input = fg(c)(input);
    else recordRenderError(errors, `unknown color "${style.fg}"`);
  }
  if (style.bg) {
    const c = resolveColor(style.bg);
    if (c) input = bg(c)(input);
    else recordRenderError(errors, `unknown color "${style.bg}"`);
  }
  return typeof input === "string" ? stringToStyledText(input).chunks[0] : input;
}

function inlineChunks(node: STMLNode, style: Style, errors: string[]): Chunk[] {
  if (node.type === "text") {
    const text = collapseWs(sanitizeTerminalText(decodeEntities(node.value)));
    return text === "" ? [] : [styledChunk(text, style, errors)];
  }
  if (node.tag === "br") return [styledChunk("\n", style, errors)];
  const next = mergeStyle(style, inlineStyle(node.tag, node.attrs));
  const padded = node.tag === "badge" || node.tag === "kbd";
  const out: Chunk[] = [];
  if (padded) out.push(styledChunk(" ", next, errors));
  for (const k of node.children) out.push(...inlineChunks(k, next, errors));
  if (padded) out.push(styledChunk(" ", next, errors));
  return out;
}

// Strip leading/trailing spaces from a finished inline run (newlines from <br>
// are preserved). chunk.text is mutable, so we trim the boundary chunks.
function trimEdges(chunks: Chunk[]): void {
  while (chunks.length > 0) {
    chunks[0].text = chunks[0].text.replace(/^ +/, "");
    if (chunks[0].text === "") chunks.shift();
    else break;
  }
  while (chunks.length > 0) {
    const last = chunks[chunks.length - 1];
    last.text = last.text.replace(/ +$/, "");
    if (last.text === "") chunks.pop();
    else break;
  }
}

function buildText(
  ctx: RenderContext,
  nodes: STMLNode[],
  style: Style,
  errors: string[],
  extra?: Record<string, unknown>,
): TextRenderable | null {
  const chunks: Chunk[] = [];
  for (const nd of nodes) chunks.push(...inlineChunks(nd, style, errors));
  trimEdges(chunks);
  if (chunks.length === 0) return null;
  return new TextRenderable(ctx, { content: new StyledText(chunks), ...extra });
}

// --- attribute coercion ---

function dimValue(v: string | undefined): number | `${number}%` | "auto" | undefined {
  if (v === undefined) return undefined;
  if (v === "auto") return "auto";
  if (/^-?\d+(\.\d+)?%$/.test(v)) return v as `${number}%`;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const numAttr = (v: string | undefined) =>
  v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined;

const mapDirection = (v: string) => (v === "col" ? "column" : v);
const mapAlign = (v: string) => (v === "start" ? "flex-start" : v === "end" ? "flex-end" : v);
const mapJustify = (v: string) =>
  v === "start"
    ? "flex-start"
    : v === "end"
      ? "flex-end"
      : v === "between"
        ? "space-between"
        : v === "around"
          ? "space-around"
          : v === "evenly"
            ? "space-evenly"
            : v;

function applyLayout(o: Record<string, unknown>, attrs: Record<string, string>): void {
  const dims: Array<[string, string]> = [
    ["width", "width"],
    ["height", "height"],
    ["min-width", "minWidth"],
    ["max-width", "maxWidth"],
    ["padding", "padding"],
    ["padding-x", "paddingX"],
    ["padding-y", "paddingY"],
    ["padding-top", "paddingTop"],
    ["padding-right", "paddingRight"],
    ["padding-bottom", "paddingBottom"],
    ["padding-left", "paddingLeft"],
    ["margin", "margin"],
    ["margin-x", "marginX"],
    ["margin-y", "marginY"],
    ["margin-top", "marginTop"],
    ["margin-bottom", "marginBottom"],
  ];
  for (const [attr, key] of dims) {
    const d = dimValue(attrs[attr]);
    if (d !== undefined) o[key] = d;
  }
  if (attrs.gap !== undefined) o.gap = numAttr(attrs.gap) ?? 0;
  if (attrs.grow !== undefined) o.flexGrow = numAttr(attrs.grow) ?? 0;
  if (attrs.shrink !== undefined) o.flexShrink = numAttr(attrs.shrink) ?? 0;
  if (attrs.basis !== undefined) o.flexBasis = dimValue(attrs.basis);
  if (attrs.direction) o.flexDirection = mapDirection(attrs.direction);
  if (attrs.align) o.alignItems = mapAlign(attrs.align);
  if (attrs.justify) o.justifyContent = mapJustify(attrs.justify);
}

function applyBox(
  o: Record<string, unknown>,
  attrs: Record<string, string>,
  errors: string[],
): void {
  applyLayout(o, attrs);
  if (attrs.bg !== undefined) {
    const c = resolveColor(attrs.bg);
    if (c) o.backgroundColor = c;
    else recordRenderError(errors, `unknown color "${attrs.bg}"`);
  }
  if ("border" in attrs || "border-style" in attrs || "border-color" in attrs) {
    o.border = "border" in attrs ? truthyAttr(attrs.border) : true;
    const bs = attrs["border-style"];
    if (bs) {
      if (isValidBorderStyle(bs)) o.borderStyle = bs;
      else recordRenderError(errors, `unknown border-style "${bs}"`);
    }
    if (o.borderColor === undefined) o.borderColor = resolveColor("muted") ?? undefined;
    if (attrs["border-color"]) {
      const c = resolveColor(attrs["border-color"]);
      if (c) o.borderColor = c;
      else recordRenderError(errors, `unknown color "${attrs["border-color"]}"`);
    }
  }
  if (attrs.title !== undefined) o.title = attrs.title;
  if (attrs["title-color"]) {
    const c = resolveColor(attrs["title-color"]);
    if (c) o.titleColor = c;
  }
  if (attrs["title-align"]) o.titleAlignment = attrs["title-align"];
}

// --- raw text helpers (for <code>, <md>, <ascii>) ---

const rawText = (el: STMLElement) =>
  el.children.map((c) => (c.type === "text" ? c.value : "")).join("");

// Strip the leading newline and shared indentation so agents can indent the
// body of a <md>/<code> block to match surrounding markup.
function dedent(text: string): string {
  const lines = text.replace(/^\n/, "").replace(/\s+$/, "").split("\n");
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    min = Math.min(min, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(min) || min === 0) return lines.join("\n");
  return lines.map((l) => l.slice(min)).join("\n");
}

// --- block builders ---

function bulletRow(
  ctx: RenderContext,
  prefix: string,
  children: STMLNode[],
  style: Style,
  errors: string[],
): BoxRenderable {
  const row = new BoxRenderable(ctx, { flexDirection: "row", width: "100%" });
  row.add(new TextRenderable(ctx, { content: prefix, fg: resolveColor("muted") ?? undefined }));
  const body = buildText(ctx, children, style, errors, { flexGrow: 1 });
  if (body) row.add(body);
  return row;
}

function buildBlock(
  ctx: RenderContext,
  el: STMLElement,
  style: Style,
  errors: string[],
): BaseRenderable | null {
  const tag = el.tag;
  switch (tag) {
    case "box":
    case "col":
    case "column":
    case "stack":
    case "section":
    case "card":
    case "row": {
      const defaults: Record<string, unknown> =
        tag === "row" ? { flexDirection: "row", gap: 1 } : { flexDirection: "column" };
      if (tag === "card") {
        defaults.border = true;
        defaults.borderStyle = "rounded";
        defaults.padding = 1;
        defaults.borderColor = resolveColor("muted") ?? undefined;
      }
      applyBox(defaults, el.attrs, errors);
      const box = new BoxRenderable(ctx, defaults);
      for (const child of buildNodes(ctx, el.children, style, errors)) box.add(child);
      return box;
    }

    case "text":
    case "p": {
      const o: Record<string, unknown> = {};
      applyLayout(o, el.attrs);
      return buildText(ctx, el.children, mergeStyle(style, attrStyle(el.attrs)), errors, o);
    }

    case "h":
    case "h1":
    case "h2":
    case "h3":
    case "heading":
    case "title": {
      const o: Record<string, unknown> = {};
      applyLayout(o, el.attrs);
      const base = mergeStyle(style, {
        bold: true,
        fg: el.attrs.fg ?? el.attrs.color ?? "heading",
      });
      if (tag === "h1" || tag === "title") base.underline = true;
      return buildText(ctx, el.children, base, errors, o);
    }

    case "hr":
    case "rule":
    case "divider": {
      const bs = el.attrs["border-style"];
      return new BoxRenderable(ctx, {
        width: "100%",
        height: 1,
        border: ["top"],
        borderStyle: bs && isValidBorderStyle(bs) ? bs : "single",
        borderColor: resolveColor(el.attrs.color ?? "muted") ?? undefined,
      });
    }

    case "spacer":
    case "space":
      return new BoxRenderable(ctx, { width: 1, height: numAttr(el.attrs.size) ?? 1 });

    case "list":
    case "ul":
    case "ol": {
      const defaults: Record<string, unknown> = { flexDirection: "column", width: "100%" };
      applyBox(defaults, el.attrs, errors);
      const box = new BoxRenderable(ctx, defaults);
      const ordered = tag === "ol";
      const marker = el.attrs.marker ?? "•";
      let idx = 1;
      for (const child of el.children) {
        if (child.type !== "element" || (child.tag !== "item" && child.tag !== "li")) continue;
        const prefix = ordered ? `${idx++}. ` : `${marker} `;
        box.add(bulletRow(ctx, prefix, child.children, style, errors));
      }
      return box;
    }

    case "item":
    case "li":
      return bulletRow(ctx, "• ", el.children, style, errors);

    case "ascii":
    case "bigtext":
    case "banner": {
      const text = (el.attrs.text ?? rawText(el)).trim();
      const fontAttr = el.attrs.font;
      const font = fontAttr && fontAttr in fonts ? (fontAttr as keyof typeof fonts) : "tiny";
      const o: Record<string, unknown> = { text, font };
      const color = resolveColor(el.attrs.color ?? el.attrs.fg);
      if (color) o.color = color;
      applyLayout(o, el.attrs);
      return new ASCIIFontRenderable(ctx, o);
    }

    case "code":
    case "pre": {
      const defaults: Record<string, unknown> = {
        flexDirection: "column",
        paddingX: 1,
        border: true,
        borderStyle: "single",
        borderColor: resolveColor("subtle") ?? undefined,
      };
      applyBox(defaults, el.attrs, errors);
      const box = new BoxRenderable(ctx, defaults);
      box.add(
        new TextRenderable(ctx, {
          content: dedent(rawText(el)),
          fg: resolveColor(el.attrs.fg ?? "") ?? undefined,
        }),
      );
      return box;
    }

    case "select": {
      const options: Array<{ name: string; description: string; value?: string }> = [];
      for (const child of el.children) {
        if (child.type !== "element" || child.tag !== "option") continue;
        options.push({
          name: child.attrs.name ?? rawText(child).trim(),
          description: child.attrs.description ?? "",
          value: child.attrs.value,
        });
      }
      const o: Record<string, unknown> = { options, width: "100%" };
      applyLayout(o, el.attrs);
      if (el.attrs.height === undefined) o.height = Math.max(1, options.length);
      return new SelectRenderable(ctx, o);
    }

    case "input": {
      const o: Record<string, unknown> = { width: 30 };
      applyLayout(o, el.attrs);
      if (el.attrs.placeholder) o.placeholder = el.attrs.placeholder;
      if (el.attrs.value) o.value = el.attrs.value;
      return new InputRenderable(ctx, o);
    }

    default: {
      recordRenderError(errors, `unknown tag <${tag}>`);
      const box = new BoxRenderable(ctx, { flexDirection: "column" });
      for (const child of buildNodes(ctx, el.children, style, errors)) box.add(child);
      return box;
    }
  }
}

// Walk a child list, grouping consecutive inline nodes into one TextRenderable
// and building block nodes individually.
function buildNodes(
  ctx: RenderContext,
  nodes: STMLNode[],
  style: Style,
  errors: string[],
): BaseRenderable[] {
  const out: BaseRenderable[] = [];
  let run: STMLNode[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const text = buildText(ctx, run, style, errors);
    if (text) out.push(text);
    run = [];
  };
  for (const nd of nodes) {
    if (nd.type === "text" || INLINE.has(nd.tag)) {
      run.push(nd);
      continue;
    }
    flush();
    const block = buildBlock(ctx, nd, style, errors);
    if (block) out.push(block);
  }
  flush();
  return out;
}

export interface BuildResult {
  root: BoxRenderable;
  errors: string[];
}

function errorMessage(err: unknown): string {
  return sanitizeTerminalText(err instanceof Error ? err.message : String(err));
}

function fallbackDocument(ctx: RenderContext, err: unknown): BuildResult {
  const root = new BoxRenderable(ctx, {
    flexDirection: "column",
    width: "100%",
    border: true,
    borderStyle: "single",
    borderColor: resolveColor("warning") ?? undefined,
    padding: 1,
  });
  root.add(
    new TextRenderable(ctx, {
      content: "Unable to render this STML snippet.",
      fg: resolveColor("warning") ?? undefined,
    }),
  );
  root.add(
    new TextRenderable(ctx, {
      content: errorMessage(err),
      fg: resolveColor("muted") ?? undefined,
    }),
  );
  return { root, errors: [`render failed: ${errorMessage(err)}`] };
}

// Parse STML markup and build a single root Renderable holding the document.
export function buildDocument(ctx: RenderContext, markup: string): BuildResult {
  try {
    const { nodes, errors } = parse(markup);
    const root = new BoxRenderable(ctx, { flexDirection: "column", width: "100%" });
    for (const child of buildNodes(ctx, nodes, {}, errors)) root.add(child);
    return { root, errors };
  } catch (err) {
    return fallbackDocument(ctx, err);
  }
}

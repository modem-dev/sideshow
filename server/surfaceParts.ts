import { z } from "zod";
import { isKnownKit, KIT_IDS } from "./kits.ts";
import type { IssueNode, SurfacePart } from "./types.ts";

export interface SurfacePartParseResult {
  parts: SurfacePart[];
  errors: string[];
}

const requiredString = (name: string) =>
  z.string({
    required_error: `requires string "${name}"`,
    invalid_type_error: `requires string "${name}"`,
  });
const optionalLooseString = z.preprocess(
  (v) => (typeof v === "string" ? v : undefined),
  z.string().optional(),
);
const looseLayout = z.preprocess(
  (v) => (v === "unified" || v === "split" ? v : undefined),
  z.enum(["unified", "split"]).optional(),
);
const optionalLooseNumber = z.preprocess(
  (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined),
  z.number().optional(),
);

const strictDiffFile = z.object({
  filename: requiredString("filename"),
  before: z.string({
    required_error: 'requires string "before" and "after"',
    invalid_type_error: 'requires string "before" and "after"',
  }),
  after: z.string({
    required_error: 'requires string "before" and "after"',
    invalid_type_error: 'requires string "before" and "after"',
  }),
  language: z.string().optional(),
});

const looseDiffFile = z
  .object({
    filename: z.string(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    language: optionalLooseString,
  })
  .transform(({ filename, before, after, language }) => ({
    filename,
    before: String(before ?? ""),
    after: String(after ?? ""),
    ...(language && { language }),
  }));

const strictTraceStep = z.object({
  label: requiredString("label"),
  kind: z.string().optional(),
  detail: z.string().optional(),
  ts: z.string().optional(),
});
const looseTraceStep = z.object({
  label: z.string(),
  kind: optionalLooseString,
  detail: optionalLooseString,
  ts: optionalLooseString,
});

const filteredArray = <T>(schema: z.ZodType<T, z.ZodTypeDef, any>) =>
  z.preprocess((raw) => {
    if (!Array.isArray(raw)) return raw;
    return raw.flatMap((item) => {
      const parsed = schema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }, z.array(schema));

// `kits` opts an html part into style/behavior bundles (kits.ts). Strict mode
// rejects an unknown id with the valid set, so a CLI/REST typo is a clean 400;
// loose mode filters unknown ids out rather than dropping the whole part.
const strictKitId = z.string().refine(isKnownKit, (id) => ({
  message: `unknown kit "${id}" — known: ${KIT_IDS.join(", ")}`,
}));
const strictHtmlPart = z.object({
  kind: z.literal("html"),
  html: requiredString("html"),
  kits: z.array(strictKitId).optional(),
});
// Loose mode keeps only known kit ids and omits the field entirely when none
// remain — so a junk `kits` never lingers as an empty or undefined key.
const looseHtmlPart = z
  .object({
    kind: z.literal("html"),
    html: requiredString("html"),
    kits: z.unknown().optional(),
  })
  .transform((p) => {
    const kits = Array.isArray(p.kits) ? p.kits.filter(isKnownKit) : [];
    return { kind: "html" as const, html: p.html, ...(kits.length > 0 ? { kits } : {}) };
  });

const strictMarkdownPart = z.object({
  kind: z.literal("markdown"),
  markdown: requiredString("markdown"),
});
// Loose mode drops a blank markdown part rather than publishing an empty card.
const looseMarkdownPart = z
  .object({ kind: z.literal("markdown"), markdown: z.string() })
  .refine((p) => p.markdown.trim().length > 0, {
    message: 'markdown part requires non-empty "markdown"',
  });

const strictMermaidPart = z.object({
  kind: z.literal("mermaid"),
  mermaid: requiredString("mermaid"),
});
// Loose mode drops a blank mermaid part rather than publishing an empty card.
const looseMermaidPart = z
  .object({ kind: z.literal("mermaid"), mermaid: z.string() })
  .refine((p) => p.mermaid.trim().length > 0, {
    message: 'mermaid part requires non-empty "mermaid"',
  });

const issueStates = ["open", "in-progress", "blocked", "done", "closed"] as const;
const strictIssueState = z.enum(issueStates);
// Loose mode keeps an unknown/missing state from dropping a whole node — it
// falls back to "open" (the only safe default: it never inflates the rollup).
const looseIssueState = z.preprocess(
  (v) => (typeof v === "string" && (issueStates as readonly string[]).includes(v) ? v : "open"),
  strictIssueState,
);
const looseRequiredString = z.preprocess((v) => (typeof v === "string" ? v : ""), z.string());

// issue-tree is the only recursive part kind, so it is the only one whose nesting
// is unbounded. The recursive zod schemas below overflow the call stack on a deep
// `children` chain (a ~1k-deep tree is only ~50 KB, far under MAX_SURFACE_BYTES),
// and so do partsByteLength and the viewer renderer. Callers bound the RAW tree
// with the iterative walk below BEFORE handing it to the schema, so the recursive
// parse only ever sees a tree within these caps.
export const MAX_ISSUE_TREE_DEPTH = 32;
export const MAX_ISSUE_TREE_NODES = 2000;

// Iterative (explicit-stack) check that a raw issue-tree root stays within the
// depth and node caps. Shape errors (non-objects, bad fields) are left to the
// schema; this only guards size so the recursive parse can't blow the stack.
export function issueTreeWithinBounds(root: unknown): boolean {
  if (!root || typeof root !== "object") return true;
  let nodes = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_ISSUE_TREE_DEPTH) return false;
    if (++nodes > MAX_ISSUE_TREE_NODES) return false;
    const children =
      node && typeof node === "object" ? (node as { children?: unknown }).children : undefined;
    if (Array.isArray(children)) {
      for (const child of children) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return true;
}

const strictIssueNode: z.ZodType<IssueNode> = z.lazy(() =>
  z.object({
    ref: requiredString("ref"),
    title: requiredString("title"),
    state: strictIssueState,
    source: z.string().optional(),
    note: z.string().optional(),
    url: z.string().optional(),
    children: z.array(strictIssueNode).optional(),
  }),
);
const looseIssueNode: z.ZodType<IssueNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z
    .object({
      ref: looseRequiredString,
      title: looseRequiredString,
      state: looseIssueState,
      source: optionalLooseString,
      note: optionalLooseString,
      url: optionalLooseString,
      children: filteredArray(looseIssueNode).optional(),
    })
    // looseRequiredString coerces a missing ref/title to "", so a junk child like
    // {} would otherwise survive as a blank, ref-less row that still counts toward
    // the rollup. Drop children with neither a ref nor a title (bottom-up, since
    // each child is already transformed before this runs).
    .transform((node) => {
      if (!node.children) return node;
      const kids = node.children.filter((c) => c.ref.trim() !== "" || c.title.trim() !== "");
      return { ...node, children: kids.length > 0 ? kids : undefined };
    }),
);

const strictIssueTreePart = z.object({
  kind: z.literal("issue-tree"),
  root: strictIssueNode,
});
// Loose mode drops a rootless / empty tree rather than publishing a blank card.
const looseIssueTreePart = z
  .object({ kind: z.literal("issue-tree"), root: looseIssueNode })
  .refine((p) => p.root.ref.trim().length > 0 || p.root.title.trim().length > 0, {
    message: 'issue-tree part requires a root with "ref" or "title"',
  });

const strictDiffPart = z
  .object({
    kind: z.literal("diff"),
    patch: z.string().optional(),
    files: z.array(strictDiffFile).optional(),
    layout: z.enum(["unified", "split"]).optional(),
  })
  .refine((p) => !!p.patch || (p.files?.length ?? 0) > 0, {
    message: 'diff part requires string "patch" or non-empty "files"',
  });
const looseDiffPart = z
  .object({
    kind: z.literal("diff"),
    patch: optionalLooseString,
    files: filteredArray(looseDiffFile).optional(),
    layout: looseLayout,
  })
  .refine((p) => !!p.patch || (p.files?.length ?? 0) > 0, {
    message: 'diff part requires string "patch" or non-empty "files"',
  });

const strictImagePart = z.object({
  kind: z.literal("image"),
  assetId: requiredString("assetId"),
  alt: z.string().optional(),
  caption: z.string().optional(),
});
const looseImagePart = z.object({
  kind: z.literal("image"),
  assetId: z.string(),
  alt: optionalLooseString,
  caption: optionalLooseString,
});

const strictTracePart = z
  .object({
    kind: z.literal("trace"),
    steps: z.array(strictTraceStep).optional(),
    assetId: z.string().optional(),
    title: z.string().optional(),
  })
  .refine((p) => !!p.assetId || (p.steps?.length ?? 0) > 0, {
    message: 'trace part requires "assetId" or non-empty "steps"',
  });
const looseTracePart = z
  .object({
    kind: z.literal("trace"),
    steps: filteredArray(looseTraceStep).optional(),
    assetId: optionalLooseString,
    title: optionalLooseString,
  })
  .refine((p) => !!p.assetId || (p.steps?.length ?? 0) > 0, {
    message: 'trace part requires "assetId" or non-empty "steps"',
  });

const strictTerminalPart = z.object({
  kind: z.literal("terminal"),
  text: requiredString("text"),
  cols: z.number().optional(),
  title: z.string().optional(),
});
const looseTerminalPart = z.object({
  kind: z.literal("terminal"),
  text: z.string(),
  cols: optionalLooseNumber,
  title: optionalLooseString,
});

const looseSurfacePart = z.union([
  looseHtmlPart,
  looseMarkdownPart,
  looseMermaidPart,
  looseDiffPart,
  looseImagePart,
  looseTracePart,
  looseTerminalPart,
  looseIssueTreePart,
]);

// Runtime SurfacePart parser shared by REST and MCP. REST uses strict mode to
// reject malformed input before it reaches storage; MCP uses tolerant mode so
// slightly-off tool calls still publish whatever valid parts they contain.
function parseSurfaceParts(raw: unknown, opts: { strict?: boolean } = {}): SurfacePartParseResult {
  if (!Array.isArray(raw)) return { parts: [], errors: ["parts must be an array"] };

  if (opts.strict === true) {
    const results = raw.map((part, i) => parseStrictPart(part, i));
    return {
      parts: results.flatMap((r) => (r.part ? [r.part] : [])),
      errors: results.flatMap((r) => r.errors),
    };
  }

  const parts: SurfacePart[] = raw.flatMap((part) => {
    // Drop an over-deep issue-tree before the recursive parse would overflow —
    // the tolerant path skips it like any other invalid part.
    if (
      part &&
      typeof part === "object" &&
      (part as { kind?: unknown }).kind === "issue-tree" &&
      !issueTreeWithinBounds((part as { root?: unknown }).root)
    ) {
      return [];
    }
    const parsed = looseSurfacePart.safeParse(part);
    return parsed.success ? [parsed.data as SurfacePart] : [];
  });
  return { parts, errors: [] };
}

export const coerceSurfaceParts = (raw: unknown): SurfacePart[] => parseSurfaceParts(raw).parts;

export function validateSurfaceParts(
  raw: unknown,
): { ok: true; parts: SurfacePart[] } | { ok: false; error: string } {
  const result = parseSurfaceParts(raw, { strict: true });
  return result.errors.length > 0
    ? { ok: false, error: result.errors.join("; ") }
    : { ok: true, parts: result.parts };
}

function parseStrictPart(
  raw: unknown,
  index: number,
): { part: SurfacePart | null; errors: string[] } {
  const path = `parts[${index}]`;
  if (!raw || typeof raw !== "object")
    return { part: null, errors: [`${path}: must be an object`] };

  const kind = (raw as { kind?: unknown }).kind;
  const schema = schemaForKind(kind);
  if (!schema) return { part: null, errors: [`${path}: unknown part kind`] };

  // Bound issue-tree nesting before the recursive parse so a deep tree is a clean
  // 400, not a stack-overflow 500.
  if (kind === "issue-tree" && !issueTreeWithinBounds((raw as { root?: unknown }).root)) {
    return {
      part: null,
      errors: [
        `${path}: issue-tree exceeds ${MAX_ISSUE_TREE_DEPTH} levels deep or ${MAX_ISSUE_TREE_NODES} nodes`,
      ],
    };
  }

  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { part: parsed.data, errors: [] }
    : { part: null, errors: formatZodErrors(parsed.error, path) };
}

function schemaForKind(kind: unknown): z.ZodType<SurfacePart> | null {
  switch (kind) {
    case "html":
      return strictHtmlPart;
    case "markdown":
      return strictMarkdownPart;
    case "mermaid":
      return strictMermaidPart;
    case "diff":
      return strictDiffPart;
    case "image":
      return strictImagePart;
    case "trace":
      return strictTracePart;
    case "terminal":
      return strictTerminalPart;
    case "issue-tree":
      return strictIssueTreePart;
    default:
      return null;
  }
}

function formatZodErrors(error: z.ZodError, prefix = "parts"): string[] {
  return error.issues.map((issue) => {
    const suffix = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
    return `${prefix}${suffix}: ${issue.message}`;
  });
}

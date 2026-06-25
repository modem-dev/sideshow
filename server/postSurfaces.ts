import { z } from "zod";
import { processFile, parsePatchFiles } from "@pierre/diffs";
import { parse as parseMermaid } from "@mermaid-js/parser";
import { isKnownKit, KIT_IDS } from "./kits.ts";
import type { Surface } from "./types.ts";

export interface SurfacePartParseResult {
  parts: Surface[];
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

// A json part carries a pre-parsed JSON value (`data: unknown`). Strict mode
// rejects a missing `data` key (null is valid — it's a JSON value); loose mode
// drops the part if `data` is absent. The transform fixes zod's inference:
// z.unknown() marks the key optional, but data is always present after the
// refine, so the output type must be { kind: "json"; data: unknown }.
const strictJsonPart = z
  .object({
    kind: z.literal("json"),
    data: z.unknown(),
  })
  .refine((p) => p.data !== undefined, {
    message: 'json part requires "data"',
  })
  .transform((p) => ({ kind: "json" as const, data: p.data }));
const looseJsonPart = z
  .object({
    kind: z.literal("json"),
    data: z.unknown(),
  })
  .refine((p) => p.data !== undefined, {
    message: 'json part requires "data"',
  })
  .transform((p) => ({ kind: "json" as const, data: p.data }));

const strictCodePart = z.object({
  kind: z.literal("code"),
  code: requiredString("code"),
  language: z.string().optional(),
  title: z.string().optional(),
  lineStart: z.number().int().min(1).optional(),
});
const looseCodePart = z.object({
  kind: z.literal("code"),
  code: z.string(),
  language: optionalLooseString,
  title: optionalLooseString,
  lineStart: optionalLooseNumber,
});

const looseSurfacePart = z.union([
  looseHtmlPart,
  looseMarkdownPart,
  looseMermaidPart,
  looseDiffPart,
  looseImagePart,
  looseTracePart,
  looseTerminalPart,
  looseJsonPart,
  looseCodePart,
]);

// Runtime SurfacePart parser shared by REST and MCP. REST uses strict mode to
// reject malformed input before it reaches storage; MCP uses tolerant mode so
// slightly-off tool calls still publish whatever valid parts they contain.
// Async because mermaid validation awaits the parser (@mermaid-js/parser).
async function parseSurfaceParts(
  raw: unknown,
  opts: { strict?: boolean } = {},
): Promise<SurfacePartParseResult> {
  if (!Array.isArray(raw)) return { parts: [], errors: ["parts must be an array"] };

  if (opts.strict === true) {
    const results = await Promise.all(raw.map((part, i) => parseStrictPart(part, i)));
    return {
      parts: results.flatMap((r) => (r.part ? [r.part] : [])),
      errors: results.flatMap((r) => r.errors),
    };
  }

  const parts: Surface[] = [];
  for (const part of raw) {
    const parsed = looseSurfacePart.safeParse(part);
    if (!parsed.success) continue;
    if ((await validateSemantics(parsed.data as Surface)).length === 0)
      parts.push(parsed.data as Surface);
  }
  return { parts, errors: [] };
}

export const coerceSurfaces = (raw: unknown): Promise<Surface[]> =>
  parseSurfaceParts(raw).then((r) => r.parts);

export async function validateSurfaces(
  raw: unknown,
): Promise<{ ok: true; parts: Surface[] } | { ok: false; error: string }> {
  const result = await parseSurfaceParts(raw, { strict: true });
  return result.errors.length > 0
    ? { ok: false, error: result.errors.join("; ") }
    : { ok: true, parts: result.parts };
}

// Renderability checks that run after the structural zod parse succeeds. Strict
// mode reports these as 400s; loose mode (MCP) drops the part. Runtime-agnostic:
// the parsers used here are the same ones richRender.ts runs server-side (JS
// regex engine, no DOM/WASM), so this is safe on the Worker DO too. The mermaid
// parser (@mermaid-js/parser, the official extraction) covers the 15
// Langium-migrated diagram types; types still on Jison (flowchart, sequence,
// class, state, er, gantt, …) are not yet in that package, so we skip
// validation for them — the viewer's existing graceful fallback handles any
// render failure. No `node:` imports, no DOM usage on the parse path.
function diffPatchHasContent(patch: string): boolean {
  let files = 0;
  for (const parsed of parsePatchFiles(patch)) files += parsed.files.length;
  if (files > 0) return true;
  const fd = processFile(patch);
  return !!(fd && (fd.name || fd.hunks?.length));
}

// Extract the diagram type keyword from mermaid source (the first non-empty,
// non-comment line's first word). The official parser's `parse(diagramType,
// text)` takes this as a separate parameter.
function mermaidDiagramType(src: string): string | null {
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed.startsWith("#")) continue;
    return trimmed.split(/\s+/)[0] ?? null;
  }
  return null;
}

async function validateSemantics(part: Surface): Promise<string[]> {
  if (part.kind === "diff" && part.patch) {
    try {
      if (!diffPatchHasContent(part.patch))
        return [
          'diff part "patch" did not parse to any file — expected a unified/git patch with --- /+++ headers and @@ hunks',
        ];
    } catch (e) {
      return ['diff part "patch" failed to parse: ' + (e instanceof Error ? e.message : "error")];
    }
  }
  if (part.kind === "mermaid") {
    const diagramType = mermaidDiagramType(part.mermaid);
    if (!diagramType)
      return ['mermaid part has no diagram type (first line should be e.g. "flowchart TD")'];
    try {
      await parseMermaid(diagramType as never, part.mermaid);
    } catch (e) {
      // Unsupported diagram types (flowchart, sequence, etc. — still on Jison)
      // skip validation; the viewer's graceful fallback handles render failures.
      if (e instanceof Error && /unknown diagram type/i.test(e.message)) return [];
      const msg = e instanceof Error ? (e.message.split("\n")[0] ?? "parse error") : "parse error";
      return [`mermaid part failed to parse: ${msg}`];
    }
  }
  return [];
}

async function parseStrictPart(
  raw: unknown,
  index: number,
): Promise<{ part: Surface | null; errors: string[] }> {
  const path = `parts[${index}]`;
  if (!raw || typeof raw !== "object")
    return { part: null, errors: [`${path}: must be an object`] };

  const kind = (raw as { kind?: unknown }).kind;
  const schema = schemaForKind(kind);
  if (!schema) return { part: null, errors: [`${path}: unknown part kind`] };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { part: null, errors: formatZodErrors(parsed.error, path) };
  const semantic = await validateSemantics(parsed.data);
  return semantic.length > 0
    ? { part: null, errors: semantic.map((m) => `${path}: ${m}`) }
    : { part: parsed.data, errors: [] };
}

function schemaForKind(kind: unknown): z.ZodType<Surface, z.ZodTypeDef, any> | null {
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
    case "json":
      return strictJsonPart;
    case "code":
      return strictCodePart;
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

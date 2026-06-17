import { z } from "zod";
import type { SurfacePart } from "./types.ts";

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

const filteredArray = <T>(schema: z.ZodType<T>) =>
  z.preprocess((raw) => {
    if (!Array.isArray(raw)) return raw;
    return raw.flatMap((item) => {
      const parsed = schema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }, z.array(schema));

const strictHtmlPart = z.object({ kind: z.literal("html"), html: requiredString("html") });
const looseHtmlPart = strictHtmlPart;

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
  looseDiffPart,
  looseImagePart,
  looseTracePart,
  looseTerminalPart,
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

  const schema = schemaForKind((raw as { kind?: unknown }).kind);
  if (!schema) return { part: null, errors: [`${path}: unknown part kind`] };

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
    case "diff":
      return strictDiffPart;
    case "image":
      return strictImagePart;
    case "trace":
      return strictTracePart;
    case "terminal":
      return strictTerminalPart;
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

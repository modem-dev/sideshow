import { z } from "zod";
import { isKnownKit, KIT_IDS } from "./kits.ts";
import { isSurfaceKind, type Surface, type SurfaceKind } from "./types.ts";

export interface SurfaceParseResult {
  surfaces: Surface[];
  // Deprecated compatibility alias for older deep imports.
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

// `kits` opts an html surface into style/behavior bundles (kits.ts). Strict mode
// rejects an unknown id with the valid set, so a CLI/REST typo is a clean 400;
// loose mode filters unknown ids out rather than dropping the whole surface.
const strictKitId = z.string().refine(isKnownKit, (id) => ({
  message: `unknown kit "${id}" — known: ${KIT_IDS.join(", ")}`,
}));
const strictHtmlSurface = z.object({
  kind: z.literal("html"),
  html: requiredString("html"),
  kits: z.array(strictKitId).optional(),
});
// Loose mode keeps only known kit ids and omits the field entirely when none
// remain — so a junk `kits` never lingers as an empty or undefined key.
const looseHtmlSurface = z
  .object({
    kind: z.literal("html"),
    html: requiredString("html"),
    kits: z.unknown().optional(),
  })
  .transform((p) => {
    const kits = Array.isArray(p.kits) ? p.kits.filter(isKnownKit) : [];
    return { kind: "html" as const, html: p.html, ...(kits.length > 0 ? { kits } : {}) };
  });

const strictMarkdownSurface = z.object({
  kind: z.literal("markdown"),
  markdown: requiredString("markdown"),
});
// Loose mode drops a blank markdown surface rather than publishing an empty card.
const looseMarkdownSurface = z
  .object({ kind: z.literal("markdown"), markdown: z.string() })
  .refine((p) => p.markdown.trim().length > 0, {
    message: 'markdown surface requires non-empty "markdown"',
  });

const strictMermaidSurface = z.object({
  kind: z.literal("mermaid"),
  mermaid: requiredString("mermaid"),
});
// Loose mode drops a blank mermaid surface rather than publishing an empty card.
const looseMermaidSurface = z
  .object({ kind: z.literal("mermaid"), mermaid: z.string() })
  .refine((p) => p.mermaid.trim().length > 0, {
    message: 'mermaid surface requires non-empty "mermaid"',
  });

const strictDiffSurface = z
  .object({
    kind: z.literal("diff"),
    patch: z.string().optional(),
    files: z.array(strictDiffFile).optional(),
    layout: z.enum(["unified", "split"]).optional(),
  })
  .refine((p) => !!p.patch || (p.files?.length ?? 0) > 0, {
    message: 'diff surface requires string "patch" or non-empty "files"',
  });
const looseDiffSurface = z
  .object({
    kind: z.literal("diff"),
    patch: optionalLooseString,
    files: filteredArray(looseDiffFile).optional(),
    layout: looseLayout,
  })
  .refine((p) => !!p.patch || (p.files?.length ?? 0) > 0, {
    message: 'diff surface requires string "patch" or non-empty "files"',
  });

const strictImageSurface = z.object({
  kind: z.literal("image"),
  assetId: requiredString("assetId"),
  alt: z.string().optional(),
  caption: z.string().optional(),
});
const looseImageSurface = z.object({
  kind: z.literal("image"),
  assetId: z.string(),
  alt: optionalLooseString,
  caption: optionalLooseString,
});

const strictTraceSurface = z
  .object({
    kind: z.literal("trace"),
    steps: z.array(strictTraceStep).optional(),
    assetId: z.string().optional(),
    title: z.string().optional(),
  })
  .refine((p) => !!p.assetId || (p.steps?.length ?? 0) > 0, {
    message: 'trace surface requires "assetId" or non-empty "steps"',
  });
const looseTraceSurface = z
  .object({
    kind: z.literal("trace"),
    steps: filteredArray(looseTraceStep).optional(),
    assetId: optionalLooseString,
    title: optionalLooseString,
  })
  .refine((p) => !!p.assetId || (p.steps?.length ?? 0) > 0, {
    message: 'trace surface requires "assetId" or non-empty "steps"',
  });

const strictTerminalSurface = z.object({
  kind: z.literal("terminal"),
  text: requiredString("text"),
  cols: z.number().optional(),
  title: z.string().optional(),
});
const looseTerminalSurface = z.object({
  kind: z.literal("terminal"),
  text: z.string(),
  cols: optionalLooseNumber,
  title: optionalLooseString,
});

// A json surface carries a pre-parsed JSON value (`data: unknown`). Strict mode
// rejects a missing `data` key (null is valid — it's a JSON value); loose mode
// drops the surface if `data` is absent. The transform fixes zod's inference:
// z.unknown() marks the key optional, but data is always present after the
// refine, so the output type must be { kind: "json"; data: unknown }.
const strictJsonSurface = z
  .object({
    kind: z.literal("json"),
    data: z.unknown(),
  })
  .refine((p) => p.data !== undefined, {
    message: 'json surface requires "data"',
  })
  .transform((p) => ({ kind: "json" as const, data: p.data }));
const looseJsonSurface = z
  .object({
    kind: z.literal("json"),
    data: z.unknown(),
  })
  .refine((p) => p.data !== undefined, {
    message: 'json surface requires "data"',
  })
  .transform((p) => ({ kind: "json" as const, data: p.data }));

const strictCodeSurface = z.object({
  kind: z.literal("code"),
  code: requiredString("code"),
  language: z.string().optional(),
  title: z.string().optional(),
  lineStart: z.number().int().min(1).optional(),
});
const looseCodeSurface = z.object({
  kind: z.literal("code"),
  code: z.string(),
  language: optionalLooseString,
  title: optionalLooseString,
  lineStart: optionalLooseNumber,
});

const looseSurfaceSchema = z.union([
  looseHtmlSurface,
  looseMarkdownSurface,
  looseMermaidSurface,
  looseDiffSurface,
  looseImageSurface,
  looseTraceSurface,
  looseTerminalSurface,
  looseJsonSurface,
  looseCodeSurface,
]);

const strictSurfaceSchemas = {
  html: strictHtmlSurface,
  markdown: strictMarkdownSurface,
  mermaid: strictMermaidSurface,
  diff: strictDiffSurface,
  image: strictImageSurface,
  trace: strictTraceSurface,
  terminal: strictTerminalSurface,
  json: strictJsonSurface,
  code: strictCodeSurface,
} satisfies Record<SurfaceKind, z.ZodType<Surface, z.ZodTypeDef, any>>;

// Runtime surface parser shared by REST and MCP. REST uses strict mode to
// reject malformed input before it reaches storage; MCP uses tolerant mode so
// slightly-off tool calls still publish whatever valid surfaces they contain.
// Async because mermaid validation awaits the parser (@mermaid-js/parser).
async function parseSurfaceList(
  raw: unknown,
  opts: { strict?: boolean } = {},
): Promise<SurfaceParseResult> {
  if (!Array.isArray(raw)) return surfaceResult([], ["surfaces must be an array"]);

  if (opts.strict === true) {
    const results = await Promise.all(raw.map((surface, i) => parseStrictSurface(surface, i)));
    return surfaceResult(
      results.flatMap((r) => (r.surface ? [r.surface] : [])),
      results.flatMap((r) => r.errors),
    );
  }

  const surfaces: Surface[] = [];
  for (const surface of raw) {
    const parsed = looseSurfaceSchema.safeParse(surface);
    if (!parsed.success) continue;
    if ((await validateSemantics(parsed.data as Surface)).length === 0)
      surfaces.push(parsed.data as Surface);
  }
  return surfaceResult(surfaces, []);
}

function surfaceResult(surfaces: Surface[], errors: string[]): SurfaceParseResult {
  return { surfaces, parts: surfaces, errors };
}

export const coerceSurfaces = (raw: unknown): Promise<Surface[]> =>
  parseSurfaceList(raw).then((r) => r.surfaces);

export async function validateSurfaces(
  raw: unknown,
): Promise<{ ok: true; surfaces: Surface[]; parts: Surface[] } | { ok: false; error: string }> {
  const result = await parseSurfaceList(raw, { strict: true });
  return result.errors.length > 0
    ? { ok: false, error: result.errors.join("; ") }
    : { ok: true, surfaces: result.surfaces, parts: result.surfaces };
}

// Renderability checks that run after the structural zod parse succeeds. Strict
// mode reports these as 400s; loose mode (MCP) drops the surface. Runtime-agnostic:
// the parsers used here are the same ones richRender.ts runs server-side (JS
// regex engine, no DOM/WASM), so this is safe on the Worker DO too. The mermaid
// parser (@mermaid-js/parser, the official extraction) covers the 15
// Langium-migrated diagram types; types still on Jison (flowchart, sequence,
// class, state, er, gantt, …) are not yet in that package, so we skip
// validation for them — the viewer's existing graceful fallback handles any
// render failure. No `node:` imports, no DOM usage on the parse path.
//
// Both parsers are imported lazily, at their point of use in validateSemantics
// below — see the note there.

// Takes the parsers rather than importing them, so the caller can load the module
// OUTSIDE its try/catch — see the mermaid branch below for why that matters.
function diffPatchHasContent(
  patch: string,
  { processFile, parsePatchFiles }: typeof import("@pierre/diffs"),
): boolean {
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

// The two parsers load at their point of use, not at module load. Together they
// are ~51 MB of RSS and ~210 ms of import time (`npm run bench:all`, process
// suite), and they are only reachable when someone publishes a diff or a mermaid
// surface — a static import made every server pay that at boot to validate content
// it may never receive. The runtime's module cache makes later publishes cheap,
// and @pierre/diffs is shared with richRender.ts, so a workspace that renders
// diffs loads it once for both.
//
// This is the other half of app.ts's lazy richRender import: leaving either half
// static keeps the whole dependency graph resident and neither one saves anything.
async function validateSemantics(surface: Surface): Promise<string[]> {
  if (surface.kind === "diff" && surface.patch) {
    const diffParsers = await import("@pierre/diffs");
    try {
      if (!diffPatchHasContent(surface.patch, diffParsers))
        return [
          'diff surface "patch" did not parse to any file — expected a unified/git patch with --- /+++ headers and @@ hunks',
        ];
    } catch (e) {
      return [
        'diff surface "patch" failed to parse: ' + (e instanceof Error ? e.message : "error"),
      ];
    }
  }
  if (surface.kind === "mermaid") {
    const diagramType = mermaidDiagramType(surface.mermaid);
    if (!diagramType)
      return ['mermaid surface has no diagram type (first line should be e.g. "flowchart TD")'];
    // Outside the try: the catch below turns a throw into "your mermaid is
    // invalid", which would be a wrong answer (and a 400 instead of a 500) if what
    // actually failed was loading the parser.
    const { parse: parseMermaid } = await import("@mermaid-js/parser");
    try {
      await parseMermaid(diagramType as never, surface.mermaid);
    } catch (e) {
      // Unsupported diagram types (flowchart, sequence, etc. — still on Jison)
      // skip validation; the viewer's graceful fallback handles render failures.
      if (e instanceof Error && /unknown diagram type/i.test(e.message)) return [];
      const msg = e instanceof Error ? (e.message.split("\n")[0] ?? "parse error") : "parse error";
      return [`mermaid surface failed to parse: ${msg}`];
    }
  }
  return [];
}

async function parseStrictSurface(
  raw: unknown,
  index: number,
): Promise<{ surface: Surface | null; errors: string[] }> {
  const path = `surfaces[${index}]`;
  if (!raw || typeof raw !== "object")
    return { surface: null, errors: [`${path}: must be an object`] };

  const kind = (raw as { kind?: unknown }).kind;
  const schema = schemaForKind(kind);
  if (!schema) return { surface: null, errors: [`${path}: unknown surface kind`] };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { surface: null, errors: formatZodErrors(parsed.error, path) };
  const semantic = await validateSemantics(parsed.data);
  return semantic.length > 0
    ? { surface: null, errors: semantic.map((m) => `${path}: ${m}`) }
    : { surface: parsed.data, errors: [] };
}

function schemaForKind(kind: unknown): z.ZodType<Surface, z.ZodTypeDef, any> | null {
  return isSurfaceKind(kind) ? strictSurfaceSchemas[kind] : null;
}

function formatZodErrors(error: z.ZodError, prefix = "surfaces"): string[] {
  return error.issues.map((issue) => {
    const suffix = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
    return `${prefix}${suffix}: ${issue.message}`;
  });
}

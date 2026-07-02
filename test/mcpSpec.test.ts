import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { HTTP_MCP_TOOLS, STDIO_MCP_INPUT_SCHEMAS } from "../server/mcpSpec.ts";
import { validateSurfaces } from "../server/postSurfaces.ts";
import {
  isSandboxedSurfaceKind,
  isSurfaceKind,
  SANDBOXED_SURFACE_KINDS,
  SURFACE_CONTENT_FIELDS,
  SURFACE_FRAME_CLASSES,
  SURFACE_KIND_METADATA,
  SURFACE_KINDS,
  type Surface,
} from "../server/types.ts";

// This suite is the guard against the regression where `json` and `code`
// surfaces shipped to CLI/REST but were never added to the MCP tool schemas —
// leaving them publishable on two tiers and invisible on a third. It pins all
// three surfaces to the one canonical list (SURFACE_KINDS): the HTTP JSON-Schema
// enum, the stdio zod enum, and the runtime validator. Add a kind to types.ts
// without teaching MCP about it (or the validator) and one of these fails.

// The exact surface JSON Schema a client receives for the canonical publish
// tool from the HTTP `tools/list` response.
const httpSurfaceSchema = (() => {
  const tool = HTTP_MCP_TOOLS.find((t) => t.name === "publish_post");
  assert.ok(tool, "publish_post tool must exist");
  return (tool as any).inputSchema.properties.surfaces.items;
})();

const httpKindEnum = (() => {
  // inputSchema.properties.surfaces.items.properties.kind.enum — the wire path.
  const enumValues = httpSurfaceSchema.properties.kind.enum;
  assert.ok(Array.isArray(enumValues), "surfaces.items.kind.enum must be an array");
  return enumValues as string[];
})();

// A representative valid example per kind, used to prove the schema +
// validator accept each advertised payload field. Include optional fields too so
// a field going missing from the MCP schema surfaces here.
const EXAMPLES: Record<(typeof SURFACE_KINDS)[number], Surface> = {
  html: { kind: "html", html: "<p>hi</p>", kits: ["issues"] },
  diff: {
    kind: "diff",
    patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b",
    files: [{ filename: "a.ts", before: "a", after: "b", language: "ts" }],
    layout: "split",
  },
  image: { kind: "image", assetId: "asset123", alt: "screenshot", caption: "after" },
  trace: {
    kind: "trace",
    assetId: "trace123",
    title: "Run trace",
    steps: [{ label: "step one", kind: "tool", detail: "ok", ts: "2026-07-02T00:00:00Z" }],
  },
  markdown: { kind: "markdown", markdown: "# heading" },
  terminal: { kind: "terminal", text: "$ ls\nfile.txt", cols: 80, title: "shell" },
  mermaid: { kind: "mermaid", mermaid: "flowchart TD\nA-->B" },
  json: { kind: "json", data: { ok: true, items: [1, 2, 3] } },
  code: { kind: "code", code: "const x = 1;", language: "ts", title: "x.ts", lineStart: 10 },
};

test("HTTP publish_post advertises exactly the canonical kind set", () => {
  assert.deepEqual([...httpKindEnum].sort(), [...SURFACE_KINDS].sort());
});

test("HTTP publish_post advertises every field used by canonical examples", () => {
  const assertFieldsAdvertised = (schema: any, value: object, path: string) => {
    assert.ok(schema?.properties, `${path} must advertise object properties`);
    for (const [key, nested] of Object.entries(value)) {
      assert.ok(Object.hasOwn(schema.properties, key), `${path} must advertise ${key}`);
      if (
        Array.isArray(nested) &&
        nested.length > 0 &&
        typeof nested[0] === "object" &&
        nested[0] !== null
      ) {
        assertFieldsAdvertised(
          schema.properties[key].items,
          nested[0] as object,
          `${path}.${key}[]`,
        );
      }
    }
  };

  for (const kind of SURFACE_KINDS) {
    assertFieldsAdvertised(httpSurfaceSchema, EXAMPLES[kind], `surface ${kind}`);
  }
});

test("every canonical kind has a worked example (no kind left untested)", () => {
  for (const kind of SURFACE_KINDS) {
    assert.ok(EXAMPLES[kind], `missing test example for kind "${kind}"`);
  }
});

test("the stdio publish schema accepts a representative example of every kind", () => {
  // The stdio schema object is z.object(STDIO_MCP_INPUT_SCHEMAS.publishPost);
  // its `surfaces` field is the array schema the MCP SDK enforces.
  const publishSchema = z.object(STDIO_MCP_INPUT_SCHEMAS.publishPost);
  for (const kind of SURFACE_KINDS) {
    const result = publishSchema.safeParse({ title: "t", surfaces: [EXAMPLES[kind]] });
    assert.ok(
      result.success,
      `stdio schema rejected kind "${kind}": ${result.success ? "" : result.error}`,
    );
  }
});

test("the stdio publish schema rejects an unknown kind", () => {
  const publishSchema = z.object(STDIO_MCP_INPUT_SCHEMAS.publishPost);
  const result = publishSchema.safeParse({ title: "t", surfaces: [{ kind: "bogus", html: "x" }] });
  assert.equal(result.success, false);
});

test("the runtime validator accepts a representative example of every kind", async () => {
  for (const kind of SURFACE_KINDS) {
    const result = await validateSurfaces([EXAMPLES[kind]]);
    assert.ok(result.ok, `validator rejected kind "${kind}": ${result.ok ? "" : result.error}`);
  }
});

test("surface-kind metadata covers every kind and drives derived helpers", () => {
  assert.deepEqual(Object.keys(SURFACE_KIND_METADATA).sort(), [...SURFACE_KINDS].sort());
  for (const kind of SURFACE_KINDS) {
    assert.equal(isSurfaceKind(kind), true);
    assert.equal(isSandboxedSurfaceKind(kind), SANDBOXED_SURFACE_KINDS.includes(kind));
    if (SURFACE_KIND_METADATA[kind].sandboxed) {
      assert.ok(isSandboxedSurfaceKind(kind));
    }
  }
  assert.equal(isSurfaceKind("bogus"), false);
  assert.equal(isSurfaceKind("toString"), false);
  assert.equal(isSandboxedSurfaceKind("bogus"), false);
  assert.equal(SURFACE_CONTENT_FIELDS.html, "html");
  assert.equal(SURFACE_CONTENT_FIELDS.diff, "patch");
  assert.equal(SURFACE_CONTENT_FIELDS.json, "data");
  assert.equal(SURFACE_FRAME_CLASSES.markdown, "mdframe");
  assert.equal(SURFACE_FRAME_CLASSES.html, undefined);
});

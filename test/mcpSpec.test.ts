import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";
import { HTTP_MCP_TOOLS, MCP_INSTRUCTIONS, STDIO_MCP_INPUT_SCHEMAS } from "../server/mcpSpec.ts";
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

test("compact MCP schemas retain critical surface and cursor semantics", () => {
  assert.match(httpSurfaceSchema.properties.html.description, /body fragment/);
  assert.match(httpSurfaceSchema.properties.markdown.description, /raw HTML is escaped/);
  assert.match(httpSurfaceSchema.properties.mermaid.description, /do not set colors/);
  assert.match(httpSurfaceSchema.properties.assetId.description, /upload_asset/);
  assert.match(httpSurfaceSchema.properties.lineStart.description, /1-based/);

  const update = HTTP_MCP_TOOLS.find((tool) => tool.name === "update_post") as any;
  assert.equal(update.inputSchema.properties.surfaces.items.description, undefined);
  assert.match(update.description, /publish_post shape/);
  const wait = HTTP_MCP_TOOLS.find((tool) => tool.name === "wait_for_feedback") as any;
  assert.match(wait.inputSchema.properties.afterSeq.description, /usually omit/);
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

test("MCP instructions and tool schemas stay within their context budgets", () => {
  const stdioSchemas = Object.values(STDIO_MCP_INPUT_SCHEMAS).map((schema) =>
    toJsonSchemaCompat(z.object(schema), { strictUnions: true }),
  );

  assert.ok(Buffer.byteLength(MCP_INSTRUCTIONS) <= 400, "MCP instructions exceeded 400 bytes");
  assert.ok(
    Buffer.byteLength(JSON.stringify(HTTP_MCP_TOOLS)) <= 15_000,
    "HTTP MCP tools exceeded 15 KB",
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(stdioSchemas)) <= 12_500,
    "stdio MCP input schemas exceeded 12.5 KB",
  );
});

test("the serialized stdio MCP catalog stays under 17 KB", () => {
  const input = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "size-test", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../mcp/server.ts")], {
    input: `${input}\n`,
    encoding: "utf8",
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const list = responses.find((response) => response.id === 2);
  assert.ok(list, "stdio MCP server omitted the tools/list response");
  assert.ok(
    Buffer.byteLength(JSON.stringify(list.result.tools)) <= 17_000,
    "stdio MCP tools exceeded 17 KB",
  );
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

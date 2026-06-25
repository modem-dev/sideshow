import assert from "node:assert/strict";
import { test } from "node:test";
import { coerceParts } from "../server/mcpHttp.ts";
import {
  collectAssetIds,
  type EvictionCandidate,
  surfacesByteLength,
  selectEvictions,
  type Surface,
} from "../server/types.ts";
import { validateSurfaces } from "../server/postSurfaces.ts";

// --- selectEvictions ---

const cand = (
  id: string,
  byteLength: number,
  lastAccessedAt: string,
  referenced = false,
): EvictionCandidate => ({ id, byteLength, lastAccessedAt, referenced });

test("selectEvictions evicts nothing when the incoming asset already fits", () => {
  const candidates = [cand("a", 100, "2026-01-01")];
  assert.deepEqual(selectEvictions(candidates, 100, 1000), []);
});

test("selectEvictions evicts oldest-first until the incoming asset fits", () => {
  const candidates = [
    cand("new", 40, "2026-03-01"),
    cand("old", 40, "2026-01-01"),
    cand("mid", 40, "2026-02-01"),
  ];
  // budget 100, existing 120, incoming 40 -> must free >=60, i.e. two oldest
  assert.deepEqual(selectEvictions(candidates, 40, 100), ["old", "mid"]);
});

test("selectEvictions evicts unreferenced before referenced, oldest within each group", () => {
  const candidates = [
    cand("ref-old", 50, "2026-01-01", true),
    cand("free-new", 50, "2026-04-01", false),
    cand("free-old", 50, "2026-02-01", false),
  ];
  // total 150, incoming 50, budget 100 -> must free 100: both unreferenced go
  // (oldest first), and the older referenced asset is spared.
  assert.deepEqual(selectEvictions(candidates, 50, 100), ["free-old", "free-new"]);
});

test("selectEvictions falls back to referenced assets only as a last resort", () => {
  const candidates = [cand("ref", 50, "2026-01-01", true), cand("free", 50, "2026-02-01", false)];
  // need to free 100 (both): unreferenced first, then the referenced one
  assert.deepEqual(selectEvictions(candidates, 100, 100), ["free", "ref"]);
});

// --- collectAssetIds ---

test("collectAssetIds gathers image and trace asset ids, ignoring html/diff", () => {
  const parts: Surface[] = [
    { kind: "html", html: "<img src=/a/raw>" }, // raw-url embeds are invisible here
    { kind: "diff", patch: "x" },
    { kind: "image", assetId: "img1" },
    { kind: "trace", assetId: "tr1", steps: [{ label: "s" }] },
    { kind: "trace", steps: [{ label: "inline only" }] }, // no assetId -> nothing
  ];
  const out = new Set<string>();
  collectAssetIds(parts, out);
  assert.deepEqual([...out].sort(), ["img1", "tr1"]);
});

// --- surfacesByteLength ---

test("surfacesByteLength counts image/trace surfaces without throwing", () => {
  const n = surfacesByteLength([
    { kind: "image", assetId: "abc", caption: "hi" },
    { kind: "trace", steps: [{ label: "step", detail: "body" }] },
  ]);
  assert.ok(n > 0);
});

// --- SurfacePart validation/coercion ---

test("validateSurfaces accepts all supported part kinds", async () => {
  const result = await validateSurfaces([
    { kind: "html", html: "<p>x</p>" },
    { kind: "html", html: "<div class=tree></div>", kits: ["issues"] },
    { kind: "diff", patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b", layout: "unified" },
    { kind: "diff", files: [{ filename: "a.ts", before: "a", after: "b" }] },
    { kind: "mermaid", mermaid: 'pie title Pets\n  "Dogs" : 386' },
    { kind: "image", assetId: "img", alt: "shot", caption: "cap" },
    { kind: "trace", steps: [{ label: "read", kind: "tool" }], title: "Trace" },
    { kind: "trace", assetId: "trace-file" },
    { kind: "json", data: { a: 1, b: [true, null, "hi"] } },
    { kind: "json", data: null },
    { kind: "json", data: 42 },
    { kind: "code", code: "const x = 1;", language: "ts", title: "a.ts" },
    { kind: "code", code: "print('hi')" },
    { kind: "code", code: "x = 1\ny = 2", language: "python", lineStart: 80 },
  ]);
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual(
      result.parts.map((p) => p.kind),
      [
        "html",
        "html",
        "diff",
        "diff",
        "mermaid",
        "image",
        "trace",
        "trace",
        "json",
        "json",
        "json",
        "code",
        "code",
        "code",
      ],
    );
});

test("validateSurfaces rejects malformed parts", async () => {
  for (const parts of [
    [{ kind: "html", html: 1 }],
    [{ kind: "html", html: "<p>x</p>", kits: ["nope"] }], // unknown kit id (strict)
    [{ kind: "diff" }],
    [{ kind: "diff", files: [{ filename: "x", before: "a" }] }],
    [{ kind: "diff", patch: "x", layout: "sideways" }],
    [{ kind: "image" }],
    [{ kind: "trace", steps: [{ detail: "missing label" }] }],
    [{ kind: "json" }], // missing data
    [{ kind: "code" }], // missing code
    [{ kind: "unknown" }],
  ]) {
    const result = await validateSurfaces(parts);
    assert.equal(result.ok, false, JSON.stringify(parts));
  }
});

test("validateSurfaces rejects a diff patch with no parseable file content", async () => {
  for (const patch of [
    "not a patch at all",
    "hello world\nfoo bar",
    "@@ -1 +1 @@\n-a\n+b", // hunk with no --- /+++ file headers
  ]) {
    const result = await validateSurfaces([{ kind: "diff", patch }]);
    assert.equal(result.ok, false, `patch ${JSON.stringify(patch)} should be rejected`);
    if (!result.ok) assert.match(result.error, /did not parse to any file/);
  }
});

test("validateSurfaces accepts real unified and git-style diff patches", async () => {
  for (const patch of [
    "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b",
    "diff --git a/x b/x\nindex 0..1 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b",
    "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n d\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-e\n+f", // multi-file
  ]) {
    const result = await validateSurfaces([{ kind: "diff", patch }]);
    assert.equal(result.ok, true, `patch ${JSON.stringify(patch)} should be accepted`);
  }
});

test("validateSurfaces accepts valid mermaid diagrams (supported types)", async () => {
  for (const mermaid of [
    'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85',
    "gitGraph\n  commit\n  commit\n  branch develop",
    "architecture-beta\n  group api(cloud)[API]",
  ]) {
    const result = await validateSurfaces([{ kind: "mermaid", mermaid }]);
    assert.equal(
      result.ok,
      true,
      `mermaid ${JSON.stringify(mermaid).slice(0, 40)} should be accepted`,
    );
  }
});

test("validateSurfaces lets unsupported mermaid types through (Jison types)", async () => {
  // flowchart, sequence, class, state, er, gantt are still on Jison — the
  // official parser doesn't cover them, so validation is skipped and the
  // viewer's graceful fallback handles any render failure.
  for (const mermaid of [
    "flowchart TD; A-->B; A-->C; B-->D",
    "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi",
    "stateDiagram-v2\n  [*] --> Active\n  Active --> Inactive",
    "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
    "gantt\n  title Project\n  section Phase 1\n  Task 1 :a1, 2024-01-01, 30d",
    "classDiagram\n  Animal <|-- Dog",
  ]) {
    const result = await validateSurfaces([{ kind: "mermaid", mermaid }]);
    assert.equal(
      result.ok,
      true,
      `unsupported type ${JSON.stringify(mermaid).slice(0, 30)} should pass through`,
    );
  }
});

test("validateSurfaces rejects invalid mermaid with a parse error (supported types)", async () => {
  for (const mermaid of [
    'pie title Pets\n  "Dogs" : broken !!@@',
    "gitGraph\n  commit\n  !!bad syntax!!",
  ]) {
    const result = await validateSurfaces([{ kind: "mermaid", mermaid }]);
    assert.equal(
      result.ok,
      false,
      `mermaid ${JSON.stringify(mermaid).slice(0, 40)} should be rejected`,
    );
    if (!result.ok) assert.match(result.error, /mermaid part failed to parse/);
  }
});

test("coerceParts drops an invalid mermaid part but keeps a valid one", async () => {
  const parts = await coerceParts([
    { kind: "mermaid", mermaid: 'pie title Pets\n  "Dogs" : 386' },
    { kind: "mermaid", mermaid: "pie\n  !!broken!!" }, // dropped (parse error)
    { kind: "html", html: "<p>kept</p>" },
  ]);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].kind, "mermaid");
  assert.equal(parts[1].kind, "html");
});

test("coerceParts drops a diff patch with no content but keeps a valid one", async () => {
  const parts = await coerceParts([
    { kind: "diff", patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b" },
    { kind: "diff", patch: "not a patch" }, // dropped (no content)
    { kind: "html", html: "<p>kept</p>" },
  ]);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].kind, "diff");
  assert.equal(parts[1].kind, "html");
});

test("coerceParts keeps valid image parts and drops ones without an assetId", async () => {
  const parts = await coerceParts([
    { kind: "image", assetId: "x", alt: "a", caption: "c" },
    { kind: "image" }, // no assetId -> dropped
  ]);
  assert.deepEqual(parts, [{ kind: "image", assetId: "x", alt: "a", caption: "c" }]);
});

test("coerceParts accepts trace by steps, by assetId, or both; drops empty/malformed", async () => {
  const parts = await coerceParts([
    { kind: "trace", steps: [{ label: "ok" }, { detail: "no label" }], title: "T" },
    { kind: "trace", assetId: "file1" },
    { kind: "trace" }, // neither steps nor assetId -> dropped
  ]);
  assert.deepEqual(parts, [
    { kind: "trace", steps: [{ label: "ok" }], title: "T" },
    { kind: "trace", assetId: "file1" },
  ]);
});

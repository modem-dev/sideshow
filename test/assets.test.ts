import assert from "node:assert/strict";
import { test } from "node:test";
import { coerceParts } from "../server/mcpHttp.ts";
import {
  collectAssetIds,
  type EvictionCandidate,
  partsByteLength,
  selectEvictions,
  type SurfacePart,
} from "../server/types.ts";
import { validateSurfaceParts } from "../server/surfaceParts.ts";

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
  const parts: SurfacePart[] = [
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

// --- partsByteLength ---

test("partsByteLength counts image/trace parts without throwing", () => {
  const n = partsByteLength([
    { kind: "image", assetId: "abc", caption: "hi" },
    { kind: "trace", steps: [{ label: "step", detail: "body" }] },
  ]);
  assert.ok(n > 0);
});

// --- SurfacePart validation/coercion ---

test("validateSurfaceParts accepts all supported part kinds", () => {
  const result = validateSurfaceParts([
    { kind: "html", html: "<p>x</p>" },
    { kind: "html", html: "<div class=tree></div>", kits: ["issues"] },
    { kind: "diff", patch: "@@ -1 +1 @@\n-a\n+b", layout: "unified" },
    { kind: "diff", files: [{ filename: "a.ts", before: "a", after: "b" }] },
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

test("validateSurfaceParts rejects malformed parts", () => {
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
    const result = validateSurfaceParts(parts);
    assert.equal(result.ok, false, JSON.stringify(parts));
  }
});

test("coerceParts keeps valid image parts and drops ones without an assetId", () => {
  const parts = coerceParts([
    { kind: "image", assetId: "x", alt: "a", caption: "c" },
    { kind: "image" }, // no assetId -> dropped
  ]);
  assert.deepEqual(parts, [{ kind: "image", assetId: "x", alt: "a", caption: "c" }]);
});

test("coerceParts accepts trace by steps, by assetId, or both; drops empty/malformed", () => {
  const parts = coerceParts([
    { kind: "trace", steps: [{ label: "ok" }, { detail: "no label" }], title: "T" },
    { kind: "trace", assetId: "file1" },
    { kind: "trace" }, // neither steps nor assetId -> dropped
  ]);
  assert.deepEqual(parts, [
    { kind: "trace", steps: [{ label: "ok" }], title: "T" },
    { kind: "trace", assetId: "file1" },
  ]);
});

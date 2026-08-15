// The benchmark suite's gate decides whether CI goes red, so the deciding logic
// gets tested like any other code. These cover the parts where a subtle mistake
// would be invisible in practice: a threshold that never fires, a floor that
// suppresses a real regression, or machine scaling applied to a metric that
// isn't machine-dependent.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareRuns,
  DEFAULT_THRESHOLDS,
  machineScale,
  resultKey,
  type BenchRun,
} from "../bench/compare.ts";
import { bytes, count, memory, time } from "../bench/harness.ts";
import { buildWorkspace, markdownSource, rng, TYPICAL } from "../bench/fixtures.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { createSqliteStorage } from "../server/sqliteStorage.ts";
import type { BenchResult } from "../bench/harness.ts";

const run = (results: BenchResult[], index = 1000): BenchRun => ({
  format: 1,
  recordedAt: "2026-01-01T00:00:00.000Z",
  machine: {
    platform: "linux",
    arch: "x64",
    cpus: 8,
    cpuModel: "test",
    nodeVersion: "v22.0.0",
    totalMemory: 1,
    index,
  },
  results,
});

const timeResult = (name: string, value: number, tolerance?: number): BenchResult => ({
  suite: "s",
  name,
  kind: "time",
  unit: "ms/op",
  value,
  tolerance,
});

test("a deterministic metric fails on a small change; a timing does not", () => {
  // 10% is nothing for a timing and everything for a byte count. Both directions
  // of that asymmetry matter: gate bytes loosely and payload bloat sails through;
  // gate timings tightly and CI is red on runner noise alone.
  const base = run([bytes("s", "payload", 10_000), timeResult("op", 10)]);
  const cur = run([bytes("s", "payload", 11_000), timeResult("op", 11)]);
  const { regressions } = compareRuns(base, cur);
  assert.deepEqual(
    regressions.map((r) => r.name),
    ["payload"],
  );
});

test("the absolute floor suppresses a large ratio on a tiny value", () => {
  // 10µs → 30µs is 3×, but nobody can feel 20µs and CI runners produce swings
  // this size for free. The floor is what keeps microbenchmarks from becoming
  // the loudest thing in the report.
  const base = run([timeResult("tiny", 0.01)]);
  const cur = run([timeResult("tiny", 0.03)]);
  assert.equal(compareRuns(base, cur).regressions.length, 0);

  // The same 3× on a value above the floor does fail.
  const bigBase = run([timeResult("real", 10)]);
  const bigCur = run([timeResult("real", 30)]);
  assert.equal(compareRuns(bigBase, bigCur).regressions.length, 1);
});

test("a per-metric tolerance overrides the default", () => {
  // 2.5× would fail the default 1.4×, but this metric declares itself noisy.
  // The tolerance is read from the CURRENT result, so loosening a gate is a
  // visible source change rather than a quiet baseline edit.
  const base = run([timeResult("noisy", 10)]);
  const cur = run([timeResult("noisy", 25, 3)]);
  assert.equal(compareRuns(base, cur).regressions.length, 0);

  // Without the declaration, the same change fails.
  assert.equal(compareRuns(base, run([timeResult("noisy", 25)])).regressions.length, 1);
});

test("machine scaling adjusts timings but never bytes, counts, or memory", () => {
  const base = run(
    [bytes("s", "b", 1000), count("s", "c", 10), memory("s", "m", 10_000_000), timeResult("t", 10)],
    1000,
  );
  // Half the index = half the speed: the same code should take twice as long.
  const cur = run(
    [bytes("s", "b", 1000), count("s", "c", 10), memory("s", "m", 10_000_000), timeResult("t", 20)],
    500,
  );
  const { comparisons, regressions, scale } = compareRuns(base, cur);
  assert.equal(scale, 2);
  assert.equal(regressions.length, 0, "a 2x slower machine is not a 2x regression");

  const byName = new Map(comparisons.map((c) => [c.name, c]));
  assert.equal(byName.get("t")!.expected, 20, "timing baseline is scaled");
  assert.equal(byName.get("b")!.expected, 1000, "bytes are not scaled");
  assert.equal(byName.get("c")!.expected, 10, "counts are not scaled");
  assert.equal(byName.get("m")!.expected, 10_000_000, "memory is not scaled");
});

test("an implausible or missing machine index is ignored rather than trusted", () => {
  // A wildly different index means the calibration itself was disturbed. Scaling
  // by it would quietly excuse (or invent) an arbitrary regression, so it is
  // discarded in favour of an unscaled comparison.
  assert.equal(machineScale(run([], 1000), run([], 1)), 1);
  assert.equal(machineScale(run([], 1000), run([], 0)), 1);
  assert.equal(machineScale(run([], 0), run([], 1000)), 1);
  assert.equal(machineScale(run([], 1000), run([], 2000)), 0.5);
});

test("new and removed metrics are reported, and neither fails the gate", () => {
  const base = run([timeResult("gone", 10)]);
  const cur = run([timeResult("fresh", 10)]);
  const { comparisons, regressions } = compareRuns(base, cur);
  assert.equal(regressions.length, 0);
  const verdicts = Object.fromEntries(comparisons.map((c) => [c.name, c.verdict]));
  assert.deepEqual(verdicts, { fresh: "new", gone: "missing" });
});

test("an improvement is labeled, not just ignored", () => {
  const base = run([bytes("s", "payload", 10_000)]);
  const cur = run([bytes("s", "payload", 5_000)]);
  const { comparisons, regressions } = compareRuns(base, cur);
  assert.equal(regressions.length, 0);
  assert.equal(comparisons[0].verdict, "improved");
});

test("thresholds are ordered by how trustworthy each metric kind is", () => {
  // Pins the intent rather than the exact constants: deterministic metrics must
  // always be gated more tightly than noisy ones, whatever the numbers become.
  assert.ok(DEFAULT_THRESHOLDS.bytes.ratio < DEFAULT_THRESHOLDS.memory.ratio);
  assert.ok(DEFAULT_THRESHOLDS.memory.ratio < DEFAULT_THRESHOLDS.time.ratio);
});

test("resultKey namespaces by suite so two suites can share a metric name", () => {
  assert.equal(resultKey({ suite: "store", name: "getPost" }), "store/getPost");
  assert.notEqual(
    resultKey({ suite: "api", name: "getPost" }),
    resultKey({ suite: "store", name: "getPost" }),
  );
});

test("time() reports a median and honours a fixed iteration count", async () => {
  let calls = 0;
  const result = await time("s", "counted", () => calls++, { iterations: 12 });
  assert.equal(calls, 12, "no warmup ops added to a fixed-iteration bench");
  assert.equal(result.stats?.samples, 12);
  assert.equal(result.kind, "time");
  assert.ok(result.value >= 0);
});

test("fixtures are deterministic — the whole point of comparing across machines", async () => {
  assert.equal(markdownSource("small", 7), markdownSource("small", 7));
  assert.notEqual(markdownSource("small", 7), markdownSource("small", 8));
  assert.notEqual(markdownSource("small"), markdownSource("large"));

  const a = rng(3);
  const b = rng(3);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test("buildWorkspace produces the shape it promises", async () => {
  const shape = { ...TYPICAL, sessions: 2, postsPerSession: 3, commentsPerSession: 4 };
  const store = new SqlStore(createSqliteStorage());
  const built = await buildWorkspace(store, shape);
  assert.equal(built.sessionIds.length, 2);
  assert.equal(built.totalPosts, 6);
  assert.equal(built.totalComments, 8);
  assert.equal((await store.listPosts()).length, 6);
  // Revisions actually applied, so history-dependent benchmarks aren't measuring
  // a workspace of untouched posts.
  const post = await store.getPost(built.postIds[0]);
  assert.equal(post?.version, shape.updatesPerPost + 1);
});

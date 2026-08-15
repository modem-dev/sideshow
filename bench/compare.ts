// Baseline comparison and the regression gate.
//
// The hard problem a benchmark suite has to solve is not measuring — it's
// deciding when a number moving is NEWS. Get that wrong in the strict direction
// and CI is permanently red for reasons nobody can fix; get it wrong in the
// loose direction and the suite silently green-lights the regression it exists
// to catch. So thresholds are set per metric CLASS, and timings additionally get
// an absolute floor and a machine-speed correction:
//
//   bytes/count  DETERMINISTIC — identical input produces an identical number on
//                every machine. Gated at 2%: effectively exact, with just enough
//                slack for a version string or timestamp changing width.
//   memory       SEMI-STABLE — GC timing and allocator behavior move it a few
//                percent run to run. Gated at 1.25× with a 1 MB floor.
//   time         NOISY — shared CI runners vary by more than this gate. Gated at
//                1.4× with a 0.5 ms floor, after normalizing by the machine
//                index (see below).
//
// Machine normalization: each run measures a fixed synthetic workload and records
// the resulting ops/sec. Comparing across machines scales the baseline's timings
// by the ratio of the two indices. This corrects for "the CI runner is 2× slower
// than the laptop that recorded the baseline" — it does NOT correct for a
// different Node major, a different CPU architecture's cache behavior, or a
// noisy-neighbor runner. Treat a cross-machine timing comparison as a signal to
// investigate, and re-record the baseline on the machine that will police it.

import type { BenchResult, MetricKind } from "./harness.ts";

export interface BenchRun {
  /** Schema version of this file's shape, so an old baseline fails loudly. */
  format: 1;
  recordedAt: string;
  git?: { commit?: string; branch?: string };
  machine: {
    platform: string;
    arch: string;
    cpus: number;
    cpuModel: string;
    nodeVersion: string;
    totalMemory: number;
    /** Calibration workload ops/sec — higher is faster. See harness.ts. */
    index: number;
  };
  results: BenchResult[];
}

export interface Threshold {
  /** Fail when current / baseline exceeds this. */
  ratio: number;
  /** …but only when the absolute change also exceeds this, in the metric's unit. */
  floor: number;
}

export const DEFAULT_THRESHOLDS: Record<MetricKind, Threshold> = {
  bytes: { ratio: 1.02, floor: 256 },
  count: { ratio: 1.02, floor: 0 },
  memory: { ratio: 1.25, floor: 1024 * 1024 },
  time: { ratio: 1.4, floor: 0.5 },
};

export type Verdict = "regressed" | "improved" | "unchanged" | "new" | "missing";

export interface Comparison {
  key: string;
  suite: string;
  name: string;
  kind: MetricKind;
  unit: string;
  baseline: number | null;
  current: number | null;
  /** Baseline scaled for machine speed (timings only); equals `baseline` otherwise. */
  expected: number | null;
  ratio: number | null;
  verdict: Verdict;
  note?: string;
}

export const resultKey = (r: Pick<BenchResult, "suite" | "name">) => `${r.suite}/${r.name}`;

/**
 * Scale factor applied to baseline timings so a baseline recorded on a faster or
 * slower machine still compares sensibly. Returns 1 when either index is missing
 * or the ratio is implausible (a wildly different index usually means the
 * calibration itself was disturbed, and silently trusting it would be worse than
 * ignoring it).
 */
export function machineScale(baseline: BenchRun, current: BenchRun): number {
  const b = baseline.machine?.index ?? 0;
  const c = current.machine?.index ?? 0;
  if (!b || !c) return 1;
  const scale = b / c;
  if (!Number.isFinite(scale) || scale <= 0.05 || scale >= 20) return 1;
  return scale;
}

export function compareRuns(
  baseline: BenchRun,
  current: BenchRun,
  thresholds: Record<MetricKind, Threshold> = DEFAULT_THRESHOLDS,
): { comparisons: Comparison[]; regressions: Comparison[]; scale: number } {
  const scale = machineScale(baseline, current);
  const baseByKey = new Map(baseline.results.map((r) => [resultKey(r), r]));
  const curByKey = new Map(current.results.map((r) => [resultKey(r), r]));
  const comparisons: Comparison[] = [];

  for (const cur of current.results) {
    const key = resultKey(cur);
    const base = baseByKey.get(key);
    if (!base) {
      comparisons.push({
        key,
        suite: cur.suite,
        name: cur.name,
        kind: cur.kind,
        unit: cur.unit,
        baseline: null,
        current: cur.value,
        expected: null,
        ratio: null,
        verdict: "new",
        note: cur.note,
      });
      continue;
    }
    // Only timings are machine-speed dependent; bytes and counts are not, and
    // scaling memory by CPU speed would be nonsense.
    //
    // Direction matters: `scale` is baselineIndex/currentIndex, and the index is
    // ops/sec, so scale > 1 means this machine is SLOWER. The same code should
    // then take proportionally longer, which means multiplying the baseline.
    const expected = cur.kind === "time" ? base.value * scale : base.value;
    const threshold = thresholds[cur.kind];
    const ratio = expected > 0 ? cur.value / expected : cur.value > 0 ? Infinity : 1;
    const delta = cur.value - expected;
    const limit = cur.tolerance ?? threshold.ratio;
    const regressed = ratio > limit && Math.abs(delta) > threshold.floor;
    const improved = ratio < 1 / limit && Math.abs(delta) > threshold.floor;
    comparisons.push({
      key,
      suite: cur.suite,
      name: cur.name,
      kind: cur.kind,
      unit: cur.unit,
      baseline: base.value,
      current: cur.value,
      expected,
      ratio,
      verdict: regressed ? "regressed" : improved ? "improved" : "unchanged",
      note: cur.note,
    });
  }

  // A metric that vanished is reported, not failed: deleting a benchmark is a
  // normal thing to do deliberately, and failing on it would make every
  // intentional removal look like a regression.
  for (const base of baseline.results) {
    const key = resultKey(base);
    if (curByKey.has(key)) continue;
    comparisons.push({
      key,
      suite: base.suite,
      name: base.name,
      kind: base.kind,
      unit: base.unit,
      baseline: base.value,
      current: null,
      expected: base.value,
      ratio: null,
      verdict: "missing",
      note: base.note,
    });
  }

  return {
    comparisons,
    regressions: comparisons.filter((c) => c.verdict === "regressed"),
    scale,
  };
}

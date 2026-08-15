// Benchmark measurement primitives. Node built-ins only (matching the repo's
// zero-build, type-stripping ethos) so `node bench/run.ts` just runs.
//
// Three ideas hold the suite together:
//
//  1. A metric is more than a number — it carries a `kind` that says how much
//     to trust it. `bytes`/`count` are DETERMINISTIC (same input, same output,
//     any machine), so a regression check can gate them almost exactly.
//     `time`/`memory` are machine- and noise-dependent, so they get generous
//     tolerances and an absolute floor. Mixing the two classes under one
//     threshold is how benchmark suites end up permanently red or useless.
//  2. Iteration counts auto-scale to a time budget rather than being pinned, so
//     a fast laptop and a slow CI runner both collect enough samples.
//  3. We report the MEDIAN, not the mean. One GC pause shouldn't move a number
//     that people are asked to compare across commits.

export type MetricKind = "time" | "bytes" | "count" | "memory";

export interface Stats {
  iterations: number;
  samples: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  opsPerSec: number;
}

export interface BenchResult {
  suite: string;
  name: string;
  kind: MetricKind;
  unit: string;
  /** The comparable value: median per-op time, or the raw byte/count/memory number. */
  value: number;
  /** Present for `time` metrics. */
  stats?: Stats;
  /** Free-text detail shown in the table (input size, backend, etc.). */
  note?: string;
  /**
   * Per-metric override of the regression ratio (see DEFAULT_TOLERANCE). Set it
   * on a metric that is known-noisy or known-tight, rather than loosening the
   * global default for everyone.
   */
  tolerance?: number;
}

export interface TimeOptions {
  /** Iterations discarded before measuring. Default: auto (~50ms of work). */
  warmup?: number;
  /** Minimum measured samples. Default 15. */
  minSamples?: number;
  /** Keep sampling until this much wall time has been measured. Default 400ms. */
  minMs?: number;
  /** Hard stop, even if minSamples/minMs are unmet. Default 3000ms. */
  maxMs?: number;
  /**
   * Run EXACTLY this many operations, one per sample, with no auto-scaling and
   * no warmup unless asked for.
   *
   * Use it for benchmarks whose operation changes the thing being measured — a
   * write that grows the store, a publish that lengthens a session. Auto-scaling
   * would run a different number of those on every machine, so the workload
   * itself (not just the clock) would differ run to run and the number would not
   * be comparable. A fixed count makes the accumulated side effects identical
   * everywhere, at the cost of fewer samples on fast machines.
   */
  iterations?: number;
  /** Shown in the results table next to the name. */
  note?: string;
  tolerance?: number;
}

const now = () => performance.now();

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(perOpSamples: number[], iterations: number): Stats {
  const sorted = [...perOpSamples].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  return {
    iterations,
    samples: sorted.length,
    min: sorted[0] ?? 0,
    median,
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
    opsPerSec: median > 0 ? 1000 / median : 0,
  };
}

/**
 * A batch size that makes one sample last long enough to out-resolve the clock.
 * Sub-millisecond samples are mostly timer quantization, so cheap operations get
 * measured in batches and the total divided back down.
 */
async function calibrateBatch(fn: () => unknown | Promise<unknown>): Promise<number> {
  let batch = 1;
  for (let attempt = 0; attempt < 20; attempt++) {
    const start = now();
    for (let i = 0; i < batch; i++) await fn();
    const elapsed = now() - start;
    if (elapsed >= 1) return batch;
    batch = Math.max(batch * 2, Math.ceil(batch * (1.5 / Math.max(elapsed, 0.001))));
    if (batch > 1_000_000) return batch;
  }
  return batch;
}

/** Time one operation, auto-scaling iterations to a budget. Reports the median. */
export async function time(
  suite: string,
  name: string,
  fn: () => unknown | Promise<unknown>,
  opts: TimeOptions = {},
): Promise<BenchResult> {
  const { minSamples = 15, minMs = 400, maxMs = 3000, iterations: fixed, note, tolerance } = opts;

  // Warm up: let JIT tiering and lazy initialization settle before measuring.
  // A fixed-iteration bench defaults to no warmup — its warmup ops would be
  // side effects that shift the starting state the count is meant to pin.
  const warmupIters = opts.warmup ?? (fixed !== undefined ? 0 : undefined);
  if (warmupIters !== undefined) {
    for (let i = 0; i < warmupIters; i++) await fn();
  } else {
    const warmStart = now();
    let warmed = 0;
    while (now() - warmStart < 50 && warmed < 10_000) {
      await fn();
      warmed++;
    }
  }

  if (fixed !== undefined) {
    const samples: number[] = [];
    for (let i = 0; i < fixed; i++) {
      const t0 = now();
      await fn();
      samples.push(now() - t0);
    }
    const stats = summarize(samples, fixed);
    return {
      suite,
      name,
      kind: "time",
      unit: "ms/op",
      value: stats.median,
      stats,
      note,
      tolerance,
    };
  }

  const batch = await calibrateBatch(fn);
  const perOp: number[] = [];
  const start = now();
  let iterations = 0;
  while (perOp.length < minSamples || now() - start < minMs) {
    const sampleStart = now();
    for (let i = 0; i < batch; i++) await fn();
    perOp.push((now() - sampleStart) / batch);
    iterations += batch;
    if (now() - start > maxMs) break;
  }

  const stats = summarize(perOp, iterations);
  return { suite, name, kind: "time", unit: "ms/op", value: stats.median, stats, note, tolerance };
}

/** A deterministic size metric — same input, same number, on any machine. */
export function bytes(suite: string, name: string, value: number, note?: string): BenchResult {
  return { suite, name, kind: "bytes", unit: "bytes", value, note };
}

/** A deterministic count metric (queries issued, events delivered, DOM nodes…). */
export function count(
  suite: string,
  name: string,
  value: number,
  note?: string,
  tolerance?: number,
): BenchResult {
  return { suite, name, kind: "count", unit: "count", value, note, tolerance };
}

export function memory(
  suite: string,
  name: string,
  value: number,
  note?: string,
  tolerance?: number,
): BenchResult {
  return { suite, name, kind: "memory", unit: "bytes", value, note, tolerance };
}

/**
 * Best-effort major GC. Requires `--expose-gc` (the npm scripts pass it); without
 * it, memory numbers include whatever garbage happened to survive, so the runner
 * warns once rather than silently reporting inflated deltas.
 */
export function collectGarbage(): boolean {
  const gc = (globalThis as { gc?: (opts?: { execution?: string }) => void }).gc;
  if (!gc) return false;
  // Three passes: the first frees most of it, later ones catch objects kept alive
  // only by finalizers/weak refs cleared in the previous pass.
  for (let i = 0; i < 3; i++) gc();
  return true;
}

export const gcAvailable = () => typeof (globalThis as { gc?: unknown }).gc === "function";

/**
 * Heap retained by whatever `build` returns. The returned value is held live
 * across the second sample (and only released after), so this measures RETAINED
 * memory rather than allocation churn.
 */
export async function retainedHeap<T>(
  build: () => T | Promise<T>,
): Promise<{ retained: number; value: T }> {
  collectGarbage();
  const before = process.memoryUsage().heapUsed;
  const value = await build();
  collectGarbage();
  const after = process.memoryUsage().heapUsed;
  // Keep `value` reachable past the measurement so the optimizer can't drop it.
  void (value as unknown);
  return { retained: Math.max(0, after - before), value };
}

/**
 * A fixed synthetic workload used to estimate how fast the current machine is,
 * so a baseline recorded on one machine can be compared on another. It mixes
 * integer math, string building, and small-object allocation to avoid rewarding
 * any single microarchitectural strength.
 *
 * This is a coarse correction, not a promise of portability — see bench/README.md.
 */
export function calibrationWorkload(): number {
  let acc = 0;
  const parts: string[] = [];
  for (let i = 0; i < 20_000; i++) {
    acc = (acc + Math.imul(i ^ (acc >>> 3), 0x9e3779b1)) | 0;
    if ((i & 0x3ff) === 0) parts.push(`${acc.toString(36)}:${i}`);
  }
  const joined = parts.join(",");
  let hash = 0;
  for (let i = 0; i < joined.length; i++) hash = (hash * 31 + joined.charCodeAt(i)) | 0;
  const objs = [];
  for (let i = 0; i < 2000; i++) objs.push({ i, k: `k${i & 63}`, v: hash ^ i });
  return objs.reduce((sum, o) => sum + (o.v & 0xff), 0) + hash;
}

/** Machine speed index in workload-runs per second. Higher is faster. */
export async function measureMachineIndex(): Promise<number> {
  const result = await time("_calibration", "machine index", () => calibrationWorkload(), {
    minSamples: 9,
    minMs: 300,
    maxMs: 1500,
  });
  return result.stats ? result.stats.opsPerSec : 0;
}

// ---------------------------------------------------------------------------
// Suite plumbing
// ---------------------------------------------------------------------------

export interface SuiteContext {
  /** Record a finished result. */
  add: (result: BenchResult) => void;
  /** Time an operation and record it under this suite. */
  time: (name: string, fn: () => unknown | Promise<unknown>, opts?: TimeOptions) => Promise<void>;
  /** True when the caller asked for a fuller (slower) run. */
  full: boolean;
  /** Only run benches whose "suite/name" matches; always true when unset. */
  matches: (name: string) => boolean;
}

export interface Suite {
  name: string;
  description: string;
  /** Suites needing a browser or child processes are excluded from the default run. */
  optional?: boolean;
  run: (ctx: SuiteContext) => Promise<void>;
}

export function makeContext(
  suite: string,
  sink: BenchResult[],
  // `filter` holds lowercased literal substrings; a metric runs if its
  // "suite/name" contains any of them. Literals rather than a pattern so a name
  // copied straight off the results table works — those are full of `/`, `:` and
  // parentheses — and so a command-line string never reaches the RegExp
  // constructor.
  opts: { full: boolean; filter?: string[] },
): SuiteContext {
  // Lowercased here rather than trusting the caller to have done it:
  // case-insensitivity is a property of matching, and splitting it across the
  // arg parser and this function is how one of the two ends up forgetting.
  const terms = opts.filter?.length ? opts.filter.map((term) => term.toLowerCase()) : null;
  const matches = (name: string) => {
    if (!terms) return true;
    const key = `${suite}/${name}`.toLowerCase();
    return terms.some((term) => key.includes(term));
  };
  return {
    full: opts.full,
    matches,
    add: (result) => {
      if (matches(result.name)) sink.push(result);
    },
    time: async (name, fn, timeOpts) => {
      if (!matches(name)) return;
      sink.push(await time(suite, name, fn, timeOpts));
    },
  };
}

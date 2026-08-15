// Benchmark runner.
//
//   node --expose-gc bench/run.ts                    # default suites, print a table
//   node --expose-gc bench/run.ts store render       # only these suites
//   node --expose-gc bench/run.ts --all              # include optional (slow) suites
//   node --expose-gc bench/run.ts --filter diff,code # only metrics containing these
//   node --expose-gc bench/run.ts --save out.json    # write results
//   node --expose-gc bench/run.ts --baseline         # record bench/baseline.json
//   node --expose-gc bench/run.ts --check            # compare, exit 1 on regression
//   node --expose-gc bench/run.ts --check --gate deterministic
//                                                    # …but only fail on bytes/counts
//   node --expose-gc bench/run.ts --markdown         # markdown table on stdout
//
// See bench/README.md for what the numbers mean and how the gate decides.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { cpus, arch, platform, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { compareRuns, type BenchRun } from "./compare.ts";
import {
  gcAvailable,
  makeContext,
  measureMachineIndex,
  type BenchResult,
  type MetricKind,
  type Suite,
} from "./harness.ts";
import {
  bold,
  dim,
  red,
  renderComparison,
  renderMachine,
  renderMarkdown,
  renderResults,
  yellow,
} from "./report.ts";
import { apiSuite } from "./suites/api.bench.ts";
import { eventsSuite } from "./suites/events.bench.ts";
import { processSuite } from "./suites/process.bench.ts";
import { renderSuite } from "./suites/render.bench.ts";
import { storeSuite } from "./suites/store.bench.ts";
import { viewerSuite } from "./suites/viewer.bench.ts";

const SUITES: Suite[] = [storeSuite, renderSuite, apiSuite, eventsSuite, processSuite, viewerSuite];

/**
 * Baselines are per-scope. The default suites and `--all` measure different sets
 * of metrics, so sharing one file would make every default run report the
 * browser and process metrics as "missing" and every `--all` run report them as
 * "new" — noise that trains people to ignore the diff.
 */
const baselinePath = (all: boolean) =>
  fileURLToPath(new URL(all ? "./baseline-all.json" : "./baseline.json", import.meta.url));

interface Options {
  suites: string[];
  all: boolean;
  /** Literal, lowercased substrings; a metric matches if it contains any of them. */
  filter?: string[];
  save?: string;
  baseline: boolean;
  check: boolean;
  /** Explicit --check path; defaults to the scope's baseline. */
  checkPath?: string;
  markdown: boolean;
  full: boolean;
  gate: GateMode;
}

/**
 * Which metric kinds may FAIL the build. Everything is always compared and
 * printed; this only decides what turns into a non-zero exit.
 *
 * `deterministic` exists for shared CI runners. A byte count means the same
 * thing on any machine, so gating it there is sound. A timing on a noisy
 * runner is not — gate those and the suite becomes a flaky test that people
 * learn to re-run, which is worse than not gating at all. Timings still print,
 * so a real slowdown is visible in the log even when it can't fail the job.
 */
type GateMode = "all" | "deterministic";
const GATED_KINDS: Record<GateMode, MetricKind[]> = {
  all: ["bytes", "count", "memory", "time"],
  deterministic: ["bytes", "count"],
};

/** Split a --filter value into lowercased literal terms; empty terms dropped. */
function parseFilter(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    suites: [],
    all: false,
    baseline: false,
    check: false,
    markdown: false,
    full: false,
    gate: "all",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") opts.all = true;
    else if (arg === "--full") opts.full = true;
    else if (arg === "--markdown") opts.markdown = true;
    else if (arg === "--baseline") opts.baseline = true;
    // Comma-separated literal substrings, OR'd, case-insensitive — deliberately
    // not a regex. Metric names are full of regex metacharacters
    // ("GET /s/:id code (cache hit)"), so a regex filter made the obvious thing
    // — pasting a metric name straight off the results table — silently match
    // nothing. It also kept a command-line argument out of the RegExp
    // constructor, which CodeQL flags as regex injection: a hand-written pattern
    // can backtrack catastrophically, and turning your own benchmark run into a
    // hang is a bad way to find that out.
    else if (arg === "--filter") opts.filter = parseFilter(argv[++i]);
    else if (arg === "--save") opts.save = argv[++i];
    else if (arg === "--gate") {
      const mode = argv[++i];
      if (mode !== "all" && mode !== "deterministic") {
        console.error(`--gate must be "all" or "deterministic", got: ${mode}`);
        process.exit(2);
      }
      opts.gate = mode;
    } else if (arg === "--check") {
      opts.check = true;
      // `--check path.json` is optional; a bare --check uses the committed baseline.
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) opts.checkPath = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        readFileSync(fileURLToPath(new URL("./run.ts", import.meta.url)), "utf8")
          .split("\n")
          .filter((l) => l.startsWith("//"))
          .map((l) => l.slice(3))
          .join("\n"),
      );
      process.exit(0);
    } else if (arg.startsWith("--")) {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    } else opts.suites.push(arg);
  }
  return opts;
}

function gitInfo(): { commit?: string; branch?: string } {
  const run = (args: string[]) => {
    try {
      return execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  };
  return {
    commit: run(["rev-parse", "--short", "HEAD"]),
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!gcAvailable()) {
    console.error(
      yellow(
        "warning: running without --expose-gc; memory numbers include uncollected garbage " +
          "and are not comparable to a baseline. Use `npm run bench`.",
      ),
    );
  }

  // A baseline recorded from a subset would silently drop every metric it didn't
  // run, and the next full --check would report them all as "new" — a baseline
  // that quietly stopped policing most of the suite. Refuse rather than record it.
  if (opts.baseline && (opts.suites.length > 0 || opts.filter?.length)) {
    console.error(
      "refusing to record a partial baseline: drop the suite names and --filter, " +
        "or use --save <path> to keep a scratch run.",
    );
    process.exit(2);
  }

  const selected = SUITES.filter((s) => {
    if (opts.suites.length > 0) return opts.suites.includes(s.name);
    return opts.all || !s.optional;
  });
  if (selected.length === 0) {
    console.error(`no suites matched. available: ${SUITES.map((s) => s.name).join(", ")}`);
    process.exit(2);
  }

  const results: BenchResult[] = [];
  const started = Date.now();

  // Calibrate before the suites, while the process is quiet — an index measured
  // after a heavy suite has already thrashed the caches would understate the
  // machine and inflate every scaled comparison.
  const index = await measureMachineIndex();

  for (const suite of selected) {
    process.stderr.write(dim(`running ${suite.name}…\n`));
    const ctx = makeContext(suite.name, results, { full: opts.full, filter: opts.filter });
    await suite.run(ctx);
  }

  const cpuList = cpus();
  const run: BenchRun = {
    format: 1,
    recordedAt: new Date().toISOString(),
    git: gitInfo(),
    machine: {
      platform: platform(),
      arch: arch(),
      cpus: cpuList.length,
      cpuModel: cpuList[0]?.model?.replace(/\s+/g, " ").trim() ?? "unknown",
      nodeVersion: process.version,
      totalMemory: totalmem(),
      index,
    },
    results,
  };

  if (opts.markdown) {
    console.log(renderMarkdown(run));
  } else {
    console.log(renderMachine(run));
    console.log(renderResults(results));
    console.log(
      dim(`\n${results.length} metrics in ${((Date.now() - started) / 1000).toFixed(1)}s`),
    );
  }

  if (opts.save) {
    writeFileSync(opts.save, `${JSON.stringify(run, null, 2)}\n`);
    console.log(dim(`saved ${opts.save}`));
  }

  if (opts.baseline) {
    const path = baselinePath(opts.all);
    writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
    console.log(`\n${bold("baseline recorded")} → ${relative(process.cwd(), path)}`);
    return;
  }

  if (opts.check) {
    const checkPath = opts.checkPath ?? baselinePath(opts.all);
    let baseline: BenchRun;
    try {
      baseline = JSON.parse(readFileSync(checkPath, "utf8")) as BenchRun;
    } catch (err) {
      console.error(red(`\ncannot read baseline at ${checkPath}: ${(err as Error).message}`));
      console.error("record one with `npm run bench:baseline`.");
      process.exit(2);
    }
    if (baseline.format !== 1) {
      console.error(red(`\nbaseline format ${baseline.format} is not supported; re-record it.`));
      process.exit(2);
    }
    const { comparisons, regressions, scale } = compareRuns(baseline, run);
    console.log(
      `\n${bold("vs baseline")} ${dim(`(${baseline.recordedAt}, ${baseline.git?.commit ?? "unknown"})`)}`,
    );
    console.log(renderComparison(comparisons, scale));

    const gated = GATED_KINDS[opts.gate];
    const failing = regressions.filter((r) => gated.includes(r.kind));
    const advisory = regressions.filter((r) => !gated.includes(r.kind));

    // Advisory regressions are printed as prominently as failing ones. The point
    // of --gate is to avoid FLAKY FAILURES, not to hide slowdowns: a timing
    // regression on a shared runner still deserves a human's attention, it just
    // shouldn't be the thing that blocks a merge.
    if (advisory.length > 0) {
      console.error(yellow(`\n${advisory.length} regression(s) not gated in "${opts.gate}" mode:`));
      for (const r of advisory) {
        console.error(yellow(`  ${r.key}: +${((r.ratio! - 1) * 100).toFixed(1)}% (${r.kind})`));
      }
    }

    if (failing.length > 0) {
      console.error(red(`\n${failing.length} regression${failing.length === 1 ? "" : "s"}:`));
      for (const r of failing) {
        console.error(
          red(`  ${r.key}: ${((r.ratio! - 1) * 100).toFixed(1)}% slower/larger than baseline`),
        );
      }
      console.error(
        dim(
          "\nIf the change is intended, re-record with `npm run bench:baseline` and say so in the PR.",
        ),
      );
      process.exit(1);
    }
    console.log(`\n${bold(advisory.length > 0 ? "no gated regressions" : "no regressions")}`);
  }
}

await main();

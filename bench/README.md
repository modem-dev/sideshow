# Benchmarks

A repeatable performance suite for sideshow: what costs CPU, what costs memory,
and whether a change made either worse.

```sh
npm run bench                  # the fast in-process suites (~1 min)
npm run bench:all              # everything, including child processes + browser
npm run bench:check            # run and fail on regression vs the committed baseline
npm run bench:baseline         # re-record the baseline
```

Narrow a run to the metrics you care about with `--filter`: comma-separated
literal substrings, OR'd, case-insensitive. It is deliberately not a regex —
metric names are full of `/`, `:` and parentheses, so pasting one straight off
the results table just works.

```sh
npm run bench -- --filter diff,code            # anything mentioning diff or code
npm run bench -- --filter 'GET /s/:id code'    # one metric, pasted from the table
```

## What it measures

| Suite     | Covers                                                                     | Default |
| --------- | -------------------------------------------------------------------------- | ------- |
| `store`   | Read/write paths per backend; how write cost scales with workspace size    | yes     |
| `render`  | Server-side surface rendering (shiki, markdown-it, diff SSR) + output size | yes     |
| `api`     | HTTP routes end to end: latency and response bytes                         | yes     |
| `events`  | SSE fan-out, event-bus dispatch, comment long-poll wakeups                 | yes     |
| `process` | Process startup, idle RSS, and which imports the memory belongs to         | `--all` |
| `viewer`  | Browser-side CPU, layout work, heap, and DOM size (Chromium via CDP)       | `--all` |

`process` and `viewer` are excluded from the default run because they spawn real
processes and a browser. Run them directly when you need them:

```sh
node --expose-gc bench/run.ts process viewer
```

The `viewer` suite needs a built viewer (`npm run build:viewer`). If your
Chromium doesn't match the pinned Playwright revision, point at one:

```sh
SIDESHOW_BENCH_CHROMIUM=/path/to/chromium npm run bench:all
```

Both skip with an explanation rather than failing the run when their
prerequisites are missing.

## Reading the output

```
  metric                          value      rate       p95  detail
  markdown/small                3.81 ms    262/s   5.63 ms  1760 B source
  markdown/small document       11.0 KB
```

`value` is the comparable number — the **median** per-op time, or the raw
byte/count/memory figure. Medians, not means, so one GC pause doesn't move a
number people compare across commits.

## Metric kinds, and how much to trust them

The suite's real job isn't measuring — it's deciding when a number moving is
news. Get that wrong strictly and CI is permanently red for reasons nobody can
fix; get it wrong loosely and the suite green-lights the regression it exists to
catch. So each metric carries a kind, and thresholds are set per kind:

| Kind     | Stability                           | Gate                 |
| -------- | ----------------------------------- | -------------------- |
| `bytes`  | Deterministic — same on any machine | 1.02× (+256 B floor) |
| `count`  | Deterministic                       | 1.02×                |
| `memory` | Semi-stable; GC timing moves it     | 1.25× (+1 MB floor)  |
| `time`   | Noisy; shared runners vary a lot    | 1.4× (+0.5 ms floor) |

A metric only fails when it exceeds **both** the ratio and the absolute floor,
so a 40% regression on a 0.1 ms operation doesn't fail the build. Individual
metrics can override the ratio (`tolerance`) — prefer that over loosening the
global default for everyone.

Deterministic metrics are the ones worth trusting most. `bytes` in particular
catches the class of regression that timing can't see: shipping more data to the
browser costs the user CPU and memory even when the server got no slower.

## Cross-machine comparison

Every run measures a fixed synthetic workload and records the result as a
machine index. `--check` scales the baseline's **timings** by the ratio of the
two indices, so a baseline recorded on a laptop still means something on a
slower CI runner.

This is a coarse correction. It does not account for a different Node major, a
different CPU architecture's cache behavior, or a noisy neighbor on a shared
runner. Treat a cross-machine timing regression as a reason to investigate, not
as proof — and if a machine is going to police the baseline, record the baseline
on that machine. `bytes` and `count` are never scaled; they don't need it.

## Methodology notes

- **Iteration counts auto-scale** to a time budget rather than being pinned, so
  fast and slow machines both collect enough samples.
- **Writes use fixed iteration counts.** A write grows the store, and on the JSON
  store the next write then costs more — an auto-scaled loop would run a
  different workload on every machine.
- **Memory needs `--expose-gc`** (the npm scripts pass it). Without it the runner
  warns, and the numbers include uncollected garbage.
- **Fixtures are deterministic**: every input is a pure function of a seed, so a
  difference in the numbers is a difference in the code.
- **Cache misses are forced with a unique cache key**, not by rotating over the
  three real themes — after three iterations those are all cached and the rest of
  the run would silently measure hits.

## What CI gates on

CI runs `npm run bench:check -- --gate deterministic`. In that mode only `bytes`
and `count` metrics can fail the job. Timings and memory are still measured,
compared, and printed — a regression is visible in the log and called out in
yellow — but they can't turn the build red.

That's deliberate. A byte count is a pure function of our code and means the same
thing on a shared runner as on a laptop. A timing on a shared runner does not. A
perf gate that fails randomly is one people learn to re-run and then stop
reading, which is worse protection than no gate at all.

Locally, `npm run bench:check` gates everything (`--gate all`, the default),
which is the right setting on a machine that isn't shared.

## Baselines

Two baselines, one per scope, because the default suites and `--all` measure
different metric sets:

| Command             | Baseline                  | Committed?                       |
| ------------------- | ------------------------- | -------------------------------- |
| `npm run bench`     | `bench/baseline.json`     | yes — this is what CI gates      |
| `npm run bench:all` | `bench/baseline-all.json` | no — gitignored, record your own |

`baseline-all.json` stays local because the browser and process suites depend on
the machine and the installed Chromium; a committed copy would mostly measure
whoever recorded it. Record one with `npm run bench:all -- --baseline`.

Recording from a subset (`bench store --baseline`, or with `--filter`) is
refused: it would silently drop every metric it didn't run, leaving a baseline
that had quietly stopped policing most of the suite. Use `--save <path>` for a
scratch run instead.

## Regressions

`npm run bench:check` prints a comparison table and exits non-zero on regression:

```
store
  metric                      baseline   current   change
  json-file/createPost         7.88 ms   12.4 ms   +57.4%  REGRESSED
```

If the change is **intended** (you knowingly traded speed for something),
re-record with `npm run bench:baseline` and say so in the PR. The baseline is
committed, so the diff makes the trade visible to reviewers instead of hiding it.

Deleting a benchmark reports as `missing` rather than failing — removing one is a
normal deliberate act, and failing on it would make every intentional removal
look like a regression.

## Adding a benchmark

Add to an existing suite in `bench/suites/`, or create one and register it in
`bench/run.ts`:

```ts
export const mySuite: Suite = {
  name: "mine",
  description: "…",
  async run(ctx) {
    await ctx.time("thing I care about", () => doTheThing(), { note: "at N items" });
    ctx.add(bytes("mine", "payload size", Buffer.byteLength(payload)));
  },
};
```

Two rules worth following:

1. **Prefer a deterministic metric where one exists.** A byte count or an
   operation count gates far more reliably than a timing.
2. **Benchmark the shape users actually hit.** A microbenchmark of a function
   nobody calls in a loop measures nothing anyone will feel.

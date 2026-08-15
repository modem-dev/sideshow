// Terminal and markdown formatting for benchmark output.

import type { BenchResult } from "./harness.ts";
import type { BenchRun, Comparison } from "./compare.ts";

const isTty = () => Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const paint = (code: string, s: string) => (isTty() ? `\u001b[${code}m${s}\u001b[0m` : s);
export const dim = (s: string) => paint("2", s);
export const bold = (s: string) => paint("1", s);
export const red = (s: string) => paint("31", s);
export const green = (s: string) => paint("32", s);
export const yellow = (s: string) => paint("33", s);

export function formatValue(value: number, unit: string): string {
  if (unit === "bytes") {
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${Math.round(value)} B`;
  }
  if (unit === "ms/op") {
    if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
    if (value >= 1) return `${value.toFixed(2)} ms`;
    if (value >= 0.001) return `${(value * 1000).toFixed(1)} µs`;
    return `${(value * 1_000_000).toFixed(0)} ns`;
  }
  return String(Math.round(value));
}

const perSec = (msPerOp: number) =>
  msPerOp > 0 ? `${Math.round(1000 / msPerOp).toLocaleString("en-US")}/s` : "—";

/** Width ignoring ANSI escapes, so colored cells still line up. */
// oxlint-disable-next-line no-control-regex
const visibleWidth = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").length;

function table(rows: string[][], align: ("left" | "right")[]): string {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => visibleWidth(r[col] ?? ""))));
  return rows
    .map((row) =>
      row
        .map((cell, col) => {
          const pad = " ".repeat(Math.max(0, widths[col] - visibleWidth(cell)));
          return align[col] === "right" ? pad + cell : cell + pad;
        })
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function renderResults(results: BenchResult[]): string {
  const out: string[] = [];
  const suites = [...new Set(results.map((r) => r.suite))];
  for (const suite of suites) {
    const rows = results.filter((r) => r.suite === suite);
    out.push("", bold(suite));
    const body: string[][] = [["  metric", "value", "rate", "p95", "detail"]];
    for (const r of rows) {
      body.push([
        `  ${r.name}`,
        formatValue(r.value, r.unit),
        r.kind === "time" ? perSec(r.value) : "",
        r.stats && r.kind === "time" ? formatValue(r.stats.p95, r.unit) : "",
        dim(r.note ?? ""),
      ]);
    }
    out.push(table(body, ["left", "right", "right", "right", "left"]));
  }
  return out.join("\n");
}

export function renderComparison(comparisons: Comparison[], scale: number): string {
  const out: string[] = [];
  if (Math.abs(scale - 1) > 0.05) {
    out.push(
      dim(
        `Baseline timings scaled by ${scale.toFixed(2)}× for machine speed ` +
          `(this machine is ${scale > 1 ? "slower" : "faster"} than the one that recorded the baseline).`,
      ),
    );
  }
  const suites = [...new Set(comparisons.map((c) => c.suite))];
  for (const suite of suites) {
    const rows = comparisons.filter((c) => c.suite === suite);
    out.push("", bold(suite));
    const body: string[][] = [["  metric", "baseline", "current", "change", ""]];
    for (const c of rows) {
      const change =
        c.ratio === null ? "—" : `${c.ratio >= 1 ? "+" : ""}${((c.ratio - 1) * 100).toFixed(1)}%`;
      const marker =
        c.verdict === "regressed"
          ? red("REGRESSED")
          : c.verdict === "improved"
            ? green("improved")
            : c.verdict === "new"
              ? yellow("new")
              : c.verdict === "missing"
                ? yellow("missing")
                : "";
      body.push([
        `  ${c.name}`,
        c.baseline === null ? "—" : formatValue(c.baseline, c.unit),
        c.current === null ? "—" : formatValue(c.current, c.unit),
        c.verdict === "regressed" ? red(change) : c.verdict === "improved" ? green(change) : change,
        marker,
      ]);
    }
    out.push(table(body, ["left", "right", "right", "right", "left"]));
  }
  return out.join("\n");
}

export function renderMachine(run: BenchRun): string {
  const m = run.machine;
  return dim(
    `${m.platform}/${m.arch} · ${m.cpus}× ${m.cpuModel} · node ${m.nodeVersion} · ` +
      `index ${Math.round(m.index).toLocaleString("en-US")}/s`,
  );
}

/** A compact markdown table, for pasting into a PR or an issue. */
export function renderMarkdown(run: BenchRun): string {
  const lines = [
    `# sideshow benchmarks`,
    "",
    `Recorded ${run.recordedAt} on ${run.machine.platform}/${run.machine.arch}, ` +
      `node ${run.machine.nodeVersion}, machine index ${Math.round(run.machine.index)}/s.`,
    "",
  ];
  for (const suite of new Set(run.results.map((r) => r.suite))) {
    lines.push(`## ${suite}`, "", "| metric | value | detail |", "| --- | ---: | --- |");
    for (const r of run.results.filter((x) => x.suite === suite)) {
      lines.push(`| ${r.name} | ${formatValue(r.value, r.unit)} | ${r.note ?? ""} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

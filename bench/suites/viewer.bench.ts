// Viewer benchmarks — the browser half of the CPU/memory story.
//
// The server can be fast and the product can still feel heavy: the viewer holds
// one sandboxed iframe per rendered surface, keeps an SSE connection open for the
// life of the tab, and re-renders on every live update. That's where a user's fan
// actually spins up, and none of the Node-side suites can see it.
//
// Measured through Chrome DevTools Protocol rather than wall-clock timers,
// because CDP exposes the numbers that are both meaningful and comparatively
// stable across runs:
//
//   ScriptDuration / TaskDuration  CPU seconds actually spent — the complaint,
//                                  quantified.
//   LayoutCount / RecalcStyleCount Deterministic-ish work counters. These catch
//                                  a render-thrash regression that a timing
//                                  number would bury in noise.
//   JSHeapUsedSize / Nodes         What the tab retains while it sits open.
//
// Chromium only: WebKit has no equivalent metrics channel. Correctness on WebKit
// is covered by the e2e suite; this is about cost, and the cost profile we can
// measure is the one worth tracking.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Type-only: erased at runtime, so the default `npm run bench` still never loads
// Playwright (the value import below is dynamic and lives inside run()).
import type { CDPSession } from "@playwright/test";
import { KIND_MIX, surfaceOfKind } from "../fixtures.ts";
import { bytes, count, memory, type Suite, type SuiteContext } from "../harness.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const viewerBundle = join(repoRoot, "viewer", "dist", "index.html");

/** Posts seeded into the benchmarked session. Enough to make per-card cost visible. */
const POSTS = 30;
/** Live updates pushed while the tab is open, to measure steady-state churn. */
const LIVE_UPDATES = 20;

interface Server {
  url: string;
  stop: () => void;
}

function bootServer(): Promise<Server> {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-bench-viewer-"));
  const proc = spawn(process.execPath, ["server/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: "0",
      SIDESHOW_DB: join(dir, "bench.db"),
      SIDESHOW_DATA: join(dir, "bench.json"),
      SIDESHOW_VERSION: "",
      SIDESHOW_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("server did not boot in time"));
    }, 30_000);
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/listening on (http:\/\/localhost:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ url: m[1], stop: () => proc.kill() });
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code})`));
    });
  });
}

async function publish(url: string, sessionId: string | undefined, index: number) {
  const res = await fetch(`${url}/api/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(sessionId ? { session: sessionId } : { agent: "bench", sessionTitle: "Viewer bench" }),
      title: `Post ${index}`,
      parts: [surfaceOfKind(KIND_MIX[index % KIND_MIX.length], "small", index % 4)],
    }),
  });
  if (!res.ok) throw new Error(`publish failed: ${res.status}`);
  return (await res.json()) as { id: string; sessionId: string };
}

type Metrics = Record<string, number>;

const readMetrics = async (cdp: CDPSession): Promise<Metrics> => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
};

/**
 * Card-count predicate as a source string rather than a closure. The node
 * typecheck program has no DOM lib (correctly — this file runs in Node), so a
 * closure referencing `document` would not compile even though it only ever
 * executes in the browser.
 */
const cardsPresent = (selector: string, n: number) =>
  `document.querySelectorAll(${JSON.stringify(selector)}).length >= ${n}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const viewerSuite: Suite = {
  name: "viewer",
  description: "Browser-side cost of the viewer: CPU, layout work, heap, and DOM size",
  // Needs a built viewer and a Chromium launch; kept out of the default run.
  optional: true,
  async run(ctx: SuiteContext) {
    if (!existsSync(viewerBundle)) {
      console.error(
        `viewer bundle missing at ${viewerBundle} — run \`npm run build:viewer\` first; skipping viewer suite.`,
      );
      return;
    }

    // Imported lazily so the default `npm run bench` never loads Playwright.
    const { chromium } = await import("@playwright/test");

    // Some environments ship a Chromium that doesn't match the pinned Playwright
    // revision. SIDESHOW_BENCH_CHROMIUM points at one explicitly rather than
    // forcing a download; without it we use whatever Playwright resolves.
    const executablePath = process.env.SIDESHOW_BENCH_CHROMIUM || undefined;
    const launch = () => chromium.launch({ executablePath });

    // Probe the launch before booting a server, so a missing browser is a clean
    // skip rather than a crash that takes down a whole `--all` run.
    try {
      await (await launch()).close();
    } catch (err) {
      console.error(
        `skipping viewer suite: cannot launch Chromium (${(err as Error).message.split("\n")[0]}).\n` +
          `Set SIDESHOW_BENCH_CHROMIUM to a Chromium binary, or run \`npx playwright install chromium\`.`,
      );
      return;
    }

    const server = await bootServer();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      const first = await publish(server.url, undefined, 0);
      // Validated before it goes into a navigation URL below — same reasoning as
      // postId in process.bench.ts: don't build a URL out of a response value
      // whose shape we never checked, and fail loudly if a publish returned an
      // error body instead of a post.
      const sessionId = first.sessionId;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
        throw new Error(`publish did not return a usable session id: ${JSON.stringify(sessionId)}`);
      }
      for (let i = 1; i < POSTS; i++) await publish(server.url, sessionId, i);

      browser = await launch();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Performance.enable");

      // Byte accounting through Playwright's response event, which follows every
      // frame — including the sandboxed surface iframes. Neither of the obvious
      // alternatives covers them: the top document's PerformanceResourceTiming
      // reports transferSize 0 for opaque-origin frames, and a page-scoped CDP
      // session never sees the frames that site isolation puts in their own
      // process. Those frames are the bytes most worth counting here.
      const responseSizes: Promise<number>[] = [];
      page.on("response", (response) => {
        // /api/events is the SSE stream: it stays open for the life of the tab, so
        // its sizes() never settles and awaiting it would hang the whole bench.
        // Its bytes are a keepalive ping every 15s — nothing this metric is about.
        if (new URL(response.url()).pathname === "/api/events") return;
        responseSizes.push(
          Promise.race([
            response
              .request()
              .sizes()
              .then((s) => s.responseBodySize + s.responseHeadersSize),
            // Belt and braces: any other request that never finishes contributes
            // zero instead of stalling the run.
            new Promise<number>((resolve) => setTimeout(() => resolve(0), 5000)),
          ]).catch(() => 0),
        );
      });

      // --- initial load -------------------------------------------------------
      const cardSelector = ".card:not(#whatsNew)";
      const startedAt = Date.now();
      await page.goto(`${server.url}/session/${sessionId}`, { waitUntil: "load" });
      await page.waitForFunction(cardsPresent(cardSelector, POSTS), undefined, {
        timeout: 30_000,
      });
      const loadMs = Date.now() - startedAt;

      // Let the surface iframes finish loading and settle before sampling, so the
      // numbers describe a rendered stream rather than one mid-flight.
      await page.waitForLoadState("networkidle").catch(() => {});
      await sleep(1500);

      const afterLoad = await readMetrics(cdp);
      ctx.add({
        suite: "viewer",
        name: `load ${POSTS}-post session to all cards`,
        kind: "time",
        unit: "ms/op",
        value: loadMs,
        note: "navigation → every card in the DOM",
        // A single unrepeatable navigation: noisier than a sampled benchmark.
        tolerance: 1.8,
      });
      ctx.add({
        suite: "viewer",
        name: "script CPU for initial load",
        kind: "time",
        unit: "ms/op",
        value: (afterLoad.ScriptDuration ?? 0) * 1000,
        note: `${POSTS} posts, CDP ScriptDuration`,
        tolerance: 1.6,
      });
      ctx.add({
        suite: "viewer",
        name: "total task CPU for initial load",
        kind: "time",
        unit: "ms/op",
        value: (afterLoad.TaskDuration ?? 0) * 1000,
        note: "CDP TaskDuration (script + layout + paint)",
        tolerance: 1.6,
      });
      ctx.add(
        memory(
          "viewer",
          "JS heap after load",
          afterLoad.JSHeapUsedSize ?? 0,
          `${POSTS} posts rendered`,
        ),
      );
      ctx.add(count("viewer", "DOM nodes after load", afterLoad.Nodes ?? 0, `${POSTS} posts`, 1.1));
      ctx.add(
        count(
          "viewer",
          "layout count for initial load",
          afterLoad.LayoutCount ?? 0,
          undefined,
          1.25,
        ),
      );
      ctx.add(
        count(
          "viewer",
          "style recalcs for initial load",
          afterLoad.RecalcStyleCount ?? 0,
          undefined,
          1.25,
        ),
      );

      const iframes = await page.locator(`${cardSelector} iframe`).count();
      ctx.add(
        count(
          "viewer",
          "surface iframes",
          iframes,
          "one opaque-origin frame per sandboxed surface",
        ),
      );

      const transferred = (await Promise.all(responseSizes)).reduce((a, b) => a + b, 0);
      ctx.add(
        bytes(
          "viewer",
          "bytes transferred for load",
          transferred,
          "viewer bundle + API + every surface iframe",
        ),
      );

      // --- live churn ----------------------------------------------------------
      // The steady state of a tab left open next to a working agent: posts stream
      // in over SSE and the stream re-renders. The two recent viewer perf fixes
      // (coalescing refreshes, compacting updates) both live on this path, so it
      // gets its own measurement rather than being folded into load cost.
      const beforeChurn = await readMetrics(cdp);
      for (let i = 0; i < LIVE_UPDATES; i++) await publish(server.url, sessionId, POSTS + i);
      await page.waitForFunction(cardsPresent(cardSelector, POSTS + LIVE_UPDATES), undefined, {
        timeout: 30_000,
      });
      await sleep(1500);
      const afterChurn = await readMetrics(cdp);

      const churnScript =
        ((afterChurn.ScriptDuration ?? 0) - (beforeChurn.ScriptDuration ?? 0)) * 1000;
      const churnTask = ((afterChurn.TaskDuration ?? 0) - (beforeChurn.TaskDuration ?? 0)) * 1000;
      ctx.add({
        suite: "viewer",
        name: "script CPU per live post",
        kind: "time",
        unit: "ms/op",
        value: churnScript / LIVE_UPDATES,
        note: `${LIVE_UPDATES} posts streamed into an open tab`,
        tolerance: 1.6,
      });
      ctx.add({
        suite: "viewer",
        name: "total task CPU per live post",
        kind: "time",
        unit: "ms/op",
        value: churnTask / LIVE_UPDATES,
        note: "CDP TaskDuration delta / posts",
        tolerance: 1.6,
      });
      ctx.add(
        count(
          "viewer",
          "layouts per live post",
          Math.round(
            ((afterChurn.LayoutCount ?? 0) - (beforeChurn.LayoutCount ?? 0)) / LIVE_UPDATES,
          ),
          "re-layout churn per streamed post",
          1.3,
        ),
      );
      ctx.add(
        memory(
          "viewer",
          "JS heap growth per live post",
          Math.max(
            0,
            ((afterChurn.JSHeapUsedSize ?? 0) - (beforeChurn.JSHeapUsedSize ?? 0)) / LIVE_UPDATES,
          ),
          "retention drift while a tab stays open",
          // Heap sampling without a forced GC in the page is inherently jumpy.
          2,
        ),
      );

      // --- idle -----------------------------------------------------------------
      // A tab nobody is looking at should cost ~nothing: the SSE keepalive is one
      // frame every 15s. Anything meaningful here is a polling or timer leak.
      const beforeIdle = await readMetrics(cdp);
      await sleep(5000);
      const afterIdle = await readMetrics(cdp);
      ctx.add({
        suite: "viewer",
        name: "idle task CPU per second",
        kind: "time",
        unit: "ms/op",
        value: (((afterIdle.TaskDuration ?? 0) - (beforeIdle.TaskDuration ?? 0)) * 1000) / 5,
        note: "open tab, no activity — should be near zero",
        tolerance: 2.5,
      });

      await context.close();
    } finally {
      await browser?.close();
      server.stop();
    }
  },
};

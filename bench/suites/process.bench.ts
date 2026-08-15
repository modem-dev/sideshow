// Whole-process benchmarks: what sideshow costs before it does any work.
//
// These spawn real child processes, so they're slower than the in-process suites
// and run with a small iteration count. They're worth the wall time because
// they're the numbers a user meets first: how long `sideshow` takes to respond,
// and how much memory the server holds while idle.
//
// RSS (not heap) is the number reported here — it's what a user sees in Activity
// Monitor, which is where the "sideshow uses too much memory" complaint starts.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { memory, type Suite, time } from "../harness.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "sideshow-bench-proc-"));
}

/** Run a command to completion and return its wall time. */
function runToCompletion(args: string[], env: Record<string, string> = {}): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
    proc.on("error", reject);
    proc.on("exit", () => resolve(performance.now() - started));
  });
}

interface RunningServer {
  url: string;
  pid: number;
  bootMs: number;
  stop: () => void;
}

/** Boot the real server and resolve once it reports a listening port. */
function bootServer(env: Record<string, string> = {}): Promise<RunningServer> {
  const dir = tmpDataDir();
  const started = performance.now();
  const proc = spawn(process.execPath, ["server/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: "0",
      SIDESHOW_DB: join(dir, "bench.db"),
      SIDESHOW_DATA: join(dir, "bench.json"),
      // Empty version disables the update check — otherwise boot time includes a
      // network round trip that has nothing to do with our code.
      SIDESHOW_VERSION: "",
      SIDESHOW_TOKEN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`server did not boot in time; output: ${out}`));
    }, 30_000);
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = out.match(/listening on (http:\/\/localhost:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({
          url: match[1],
          pid: proc.pid ?? 0,
          bootMs: performance.now() - started,
          stop: () => proc.kill(),
        });
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}: ${out}`));
    });
  });
}

/** Resident set size of another process, in bytes. Linux/macOS `ps`. */
function rssOf(pid: number): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ps", ["-o", "rss=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("error", () => resolve(0));
    // `ps` reports kilobytes.
    proc.on("exit", () => resolve((Number(out.trim()) || 0) * 1024));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Check that an id parsed out of an HTTP response looks like one before it goes
 * into another request's URL (see newId in server/types.ts: url-safe base64).
 *
 * The bench only ever talks to a server it spawned itself, so this isn't
 * defending against a hostile peer — it's refusing to build a URL out of a value
 * we haven't looked at. It also fails loudly and immediately if a publish returns
 * an error body instead of a post, which otherwise shows up as a confusing 404 on
 * the next line. CodeQL flags the unchecked version as request forgery, and it's
 * right that the shape was unverified.
 */
function postId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error(`publish did not return a usable post id: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * RSS and wall time for importing one module into an otherwise-empty process.
 *
 * The idle-server number says the server holds a lot of memory; it doesn't say
 * whose. This does. Each module is loaded in its own child process and the child
 * reports its own RSS, so the cost is attributed rather than guessed — and the
 * `none` row gives the Node baseline to subtract.
 */
function importCost(specifier: string | null): Promise<{ rss: number; ms: number }> {
  const script = specifier
    ? `const t=performance.now();await import(${JSON.stringify(specifier)});` +
      `console.log(JSON.stringify({rss:process.memoryUsage().rss,ms:performance.now()-t}));`
    : `console.log(JSON.stringify({rss:process.memoryUsage().rss,ms:0}));`;
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      try {
        resolve(JSON.parse(out.trim()) as { rss: number; ms: number });
      } catch {
        reject(new Error(`import probe for ${specifier ?? "none"} failed (exit ${code}): ${out}`));
      }
    });
  });
}

/**
 * Modules that dominate the server's module graph, loaded cheapest-first.
 *
 * Reading these: subtract the `node baseline` row to get a module's own cost, and
 * note that any row importing a LOCAL `.ts` file also carries Node's type-stripping
 * overhead — the transpiler loads on the first `.ts` import and costs ~25 MB by
 * itself, which is why `server/types.ts` is in the list as a floor to subtract.
 * That overhead is a dev-run artifact: the published package ships compiled `.js`
 * in `dist/`, so an installed CLI never pays it. The `server RSS idle` number
 * above does include it, because it runs `server/index.ts` from source.
 *
 * The npm-package rows have no such caveat and are directly comparable.
 */
const IMPORT_TARGETS: [name: string, specifier: string | null][] = [
  ["node baseline (no imports)", null],
  ["server/types.ts (type-strip floor)", "./server/types.ts"],
  ["hono", "hono"],
  ["markdown-it", "markdown-it"],
  ["shiki", "shiki"],
  ["@mermaid-js/parser", "@mermaid-js/parser"],
  ["@pierre/diffs", "@pierre/diffs"],
  // The two modules deliberately kept OFF the boot path (see the dynamic imports
  // in app.ts and postSurfaces.ts). If either becomes a static import again,
  // server/app.ts jumps to roughly the richRender row and this suite shows it.
  ["server/richRender.ts", "./server/richRender.ts"],
  ["server/postSurfaces.ts", "./server/postSurfaces.ts"],
  ["server/app.ts", "./server/app.ts"],
];

export const processSuite: Suite = {
  name: "process",
  description: "Process startup time and idle/loaded resident memory (spawns real processes)",
  // Spawning servers is slow and needs `ps`; keep it out of the default run.
  optional: true,
  async run(ctx) {
    // --- CLI startup ---------------------------------------------------------
    // Every CLI invocation pays module load. Agents call the CLI per publish, so
    // this is multiplied by however chatty the agent is.
    if (ctx.matches("CLI: sideshow help")) {
      ctx.add(
        await time(
          "process",
          "CLI: sideshow help",
          () => runToCompletion(["bin/sideshow.js", "help"]),
          {
            warmup: 1,
            minSamples: 5,
            minMs: 200,
            maxMs: 8000,
            note: "cold node process per invocation",
          },
        ),
      );
    }

    // --- server boot + idle footprint ---------------------------------------
    if (ctx.matches("server boot to listening")) {
      const boots: number[] = [];
      for (let i = 0; i < 3; i++) {
        const server = await bootServer();
        boots.push(server.bootMs);
        server.stop();
        await sleep(50);
      }
      boots.sort((a, b) => a - b);
      ctx.add({
        suite: "process",
        name: "server boot to listening",
        kind: "time",
        unit: "ms/op",
        value: boots[Math.floor(boots.length / 2)],
        note: "empty workspace, update check disabled",
        stats: {
          iterations: boots.length,
          samples: boots.length,
          min: boots[0],
          median: boots[Math.floor(boots.length / 2)],
          p95: boots[boots.length - 1],
          max: boots[boots.length - 1],
          opsPerSec: 0,
        },
        tolerance: 1.8,
      });
    }

    if (ctx.matches("server RSS idle")) {
      const server = await bootServer();
      // Let boot allocations settle before sampling.
      await sleep(750);
      ctx.add(
        memory("process", "server RSS idle", await rssOf(server.pid), "just booted, no requests"),
      );

      // The first rich surface loads shiki's themes and grammars into the server
      // process; that step is invisible in an idle reading but permanent
      // afterwards. Measuring both makes the jump attributable.
      const publish = await fetch(`${server.url}/api/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "bench",
          agent: "bench",
          parts: [{ kind: "code", code: "const x = 1;\n", language: "typescript" }],
        }),
      });
      const post = (await publish.json()) as { id: string };
      await (await fetch(`${server.url}/s/${postId(post.id)}?part=0`)).text();
      await sleep(750);
      ctx.add(
        memory(
          "process",
          "server RSS after first rich render",
          await rssOf(server.pid),
          "shiki themes + grammars now resident",
        ),
      );
      server.stop();
    }

    // --- where the idle memory goes -----------------------------------------
    // Attribution for the idle RSS above. The server's module graph is loaded
    // eagerly — importing server/app.ts pulls in richRender.ts, which pulls in
    // shiki and @pierre/diffs — so a server that never renders a rich surface
    // still pays for the ones it might.
    for (const [name, specifier] of IMPORT_TARGETS) {
      const metric = `import RSS: ${name}`;
      if (!ctx.matches(metric)) continue;
      // Median of three: module loading hits the filesystem, and a cold cache on
      // the first probe would otherwise be read as a difference between modules.
      const runs = [
        await importCost(specifier),
        await importCost(specifier),
        await importCost(specifier),
      ];
      const rss = runs.map((r) => r.rss).sort((a, b) => a - b)[1];
      const ms = runs.map((r) => r.ms).sort((a, b) => a - b)[1];
      ctx.add(
        memory("process", metric, rss, specifier ? `import "${specifier}"` : "empty process"),
      );
      if (specifier) {
        ctx.add({
          suite: "process",
          name: `import time: ${name}`,
          kind: "time",
          unit: "ms/op",
          value: ms,
          note: "cold module graph load",
          tolerance: 1.8,
        });
      }
    }
  },
};

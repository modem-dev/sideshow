import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "../server/app.ts";
import { JsonFileStore } from "../server/storage.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sideshow.js");

function run(...args: string[]) {
  return runWith({}, ...args);
}

// Richer runner: optional cwd (install-hook writes ./.claude), env (point the
// CLI at the test server), and stdin (the hook reads its payload from stdin).
function runWith(
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string },
  ...args: string[]
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: opts.cwd, env: opts.env ? { ...process.env, ...opts.env } : process.env },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
      },
    );
    if (opts.stdin != null) child.stdin!.end(opts.stdin);
  });
}

// A real listening server for the commands that hit the network (the CLI talks
// over fetch, not in-process). Stub viewer so no build is needed.
function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-cli-"));
  const store = new JsonFileStore(join(dir, "data.json"));
  const app = createApp({
    store,
    viewerHtml: "<html>viewer</html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    agentHowtoText: "# agent how-to",
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({
        url: `http://localhost:${info.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<any>);

// --- version ---

for (const flag of ["--version", "-V", "version"]) {
  test(`${flag} prints the version`, async () => {
    const { code, stdout } = await run(...(flag.startsWith("-") ? [flag] : [flag]));
    assert.equal(code, 0);
    assert.match(stdout, /^sideshow \d+\.\d+\.\d+/);
  });
}

test("version runs end-to-end (update check is best-effort)", async () => {
  const { code, stdout } = await run("version");
  assert.equal(code, 0);
  assert.match(stdout, /^sideshow \d+\.\d+\.\d+/);
});

// None of these reach the network: --help and option errors resolve in
// parsing, before any request (no server needs to be running).

for (const cmd of [
  "serve",
  "publish",
  "diff",
  "update",
  "wait",
  "watch",
  "comment",
  "list",
  "kits",
]) {
  test(`${cmd} --help prints usage and exits 0`, async () => {
    const { code, stdout, stderr } = await run(cmd, "--help");
    assert.equal(code, 0);
    assert.match(stdout, /usage:/);
    assert.equal(stderr, "");
  });
}

test("-h is a short alias for --help", async () => {
  const { code, stdout } = await run("publish", "-h");
  assert.equal(code, 0);
  assert.match(stdout, /usage:/);
});

test("--help on a flag-less subcommand prints usage instead of running it", async () => {
  // would otherwise seed demo data (or fail reaching the server)
  const { code, stdout } = await run("demo", "--help");
  assert.equal(code, 0);
  assert.match(stdout, /usage:/);
});

test("unknown option fails with a one-line error, not a stack trace", async () => {
  const { code, stdout, stderr } = await run("publish", "--bogus");
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /^sideshow: Unknown option '--bogus' — run "sideshow help"\n$/);
});

test("missing option value fails with a one-line error, not a stack trace", async () => {
  const { code, stderr } = await run("update", "id123", "--title");
  assert.equal(code, 1);
  assert.match(
    stderr,
    /^sideshow: Option '--title <value>' argument missing — run "sideshow help"\n$/,
  );
});

test("a non-numeric --after fails fast instead of being silently dropped", async () => {
  const { code, stderr } = await run("watch", "--after", "abc");
  assert.equal(code, 1);
  assert.match(stderr, /--after must be a number/);
});

test("watch streams each new user comment as one line and re-arms", async () => {
  const server = await serveApp();
  let child;
  try {
    const session = await post(`${server.url}/api/sessions`, { agent: "e2e", title: "Watch" });
    const snippet = await post(`${server.url}/api/snippets`, {
      html: "<p>x</p>",
      title: "Doc",
      session: session.id,
    });

    child = spawn(process.execPath, [CLI, "watch"], {
      env: { ...process.env, SIDESHOW_URL: server.url, SIDESHOW_SESSION: session.id },
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));

    // first comment, on a post — should surface with its title and id
    await post(`${server.url}/api/comments`, {
      surface: snippet.id,
      text: "tighten\nthe spacing",
      author: "user",
    });
    await waitFor(() => stdout.includes("tighten the spacing"));
    assert.match(stdout, /sideshow comment on “Doc” \(post .+\): “tighten the spacing”/);

    // a second comment proves the loop re-armed (not a one-shot)
    await post(`${server.url}/api/comments`, {
      surface: snippet.id,
      text: "and ship it",
      author: "user",
    });
    await waitFor(() => stdout.includes("and ship it"));
    assert.match(stdout, /sideshow comment on “Doc” \(post .+\): “and ship it”/);

    // exactly-once: neither comment is repeated across the re-arming polls
    assert.equal(stdout.match(/tighten the spacing/g)?.length, 1);
  } finally {
    // Kill in finally so a failed assertion can't leave the streaming child
    // alive — an open SSE connection would otherwise block server.close().
    child?.kill();
    await server.close();
  }
});

async function waitFor(pred: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("publish --kit puts the (deduped) kit ids on the html part", async () => {
  const server = await serveApp();
  try {
    const dir = mkdtempSync(join(tmpdir(), "sideshow-kit-"));
    const file = join(dir, "x.html");
    writeFileSync(file, "<div class=tree></div>");
    const { code, stdout } = await runWith(
      { env: { SIDESHOW_URL: server.url } },
      "publish",
      file,
      "--kit",
      "issues",
      "--kit",
      "slides,issues",
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    const full = await fetch(`${server.url}/api/surfaces/${out.id}`).then((r) => r.json() as any);
    assert.deepEqual(full.surfaces[0].kits, ["issues", "slides"]);
  } finally {
    await server.close();
  }
});

test("publish --kit with an unknown id fails with a clear error", async () => {
  const server = await serveApp();
  try {
    const dir = mkdtempSync(join(tmpdir(), "sideshow-kit-"));
    const file = join(dir, "x.html");
    writeFileSync(file, "<p>x</p>");
    const { code, stderr } = await runWith(
      { env: { SIDESHOW_URL: server.url } },
      "publish",
      file,
      "--kit",
      "bogus",
    );
    assert.notEqual(code, 0);
    assert.match(stderr, /unknown kit "bogus"/);
  } finally {
    await server.close();
  }
});

test("kits lists the board's available kits", async () => {
  const server = await serveApp();
  try {
    const { code, stdout } = await runWith({ env: { SIDESHOW_URL: server.url } }, "kits");
    assert.equal(code, 0);
    const kits = JSON.parse(stdout);
    assert.ok(kits.some((k: any) => k.id === "issues"));
    assert.ok(kits.some((k: any) => k.id === "slides"));
  } finally {
    await server.close();
  }
});

test("install-hook --print emits a Stop hook that runs `sideshow hook`", async () => {
  const { code, stdout } = await run("install-hook", "--print");
  assert.equal(code, 0);
  const cfg = JSON.parse(stdout);
  const cmd = cfg.hooks.Stop[0].hooks[0].command;
  assert.equal(cfg.hooks.Stop[0].hooks[0].type, "command");
  assert.match(cmd, /sideshow(\.js)?["']?\s+hook\b/);
});

test("install-hook merges into existing Stop hooks and is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-hook-"));
  const settings = join(dir, ".claude", "settings.local.json");
  // first install — the CLI creates .claude/ and the settings file
  await runWith({ cwd: dir }, "install-hook");
  // splice in a pre-existing, unrelated Stop hook whose path contains both
  // "sideshow" and "hook" — install must not mistake it for its own and skip.
  let cfg = JSON.parse(readFileSync(settings, "utf8"));
  cfg.hooks.Stop.unshift({
    hooks: [{ type: "command", command: 'node ".../sideshow-stop-hook.mjs" check' }],
  });
  writeFileSync(settings, JSON.stringify(cfg));

  // re-running sees our own entry already present → idempotent, no duplicate,
  // and the unrelated feedback hook is preserved.
  const again = await runWith({ cwd: dir }, "install-hook");
  assert.match(again.stdout, /already-installed/);
  cfg = JSON.parse(readFileSync(settings, "utf8"));
  const cmds = cfg.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.equal(cmds.filter((c: string) => /sideshow(\.js)?["']?\s+hook\b/.test(c)).length, 1);
  assert.ok(cmds.some((c: string) => c.includes("sideshow-stop-hook.mjs")));
});

test("hook reads its stdin payload and syncs the trace for the matching cwd", async () => {
  const server = await serveApp();
  try {
    const projectCwd = "/tmp/sideshow-hook-project";
    const session = await post(`${server.url}/api/sessions`, {
      agent: "e2e",
      title: "Hooked",
      cwd: projectCwd,
    });

    // a minimal Claude Code transcript: two prompts around a tool call
    const transcript = join(mkdtempSync(join(tmpdir(), "sideshow-tx-")), "t.jsonl");
    writeFileSync(
      transcript,
      [
        `{"timestamp":"2026-06-18T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"draw me a card"}]}}`,
        `{"timestamp":"2026-06-18T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo hi"}}]}}`,
        `{"timestamp":"2026-06-18T00:00:02.000Z","message":{"role":"user","content":[{"type":"text","text":"make it blue"}]}}`,
      ].join("\n"),
    );

    const payload = JSON.stringify({
      hook_event_name: "Stop",
      transcript_path: transcript,
      cwd: projectCwd,
    });
    // no --session: the hook resolves it purely from the payload cwd
    const { code, stdout } = await runWith(
      { env: { SIDESHOW_URL: server.url }, stdin: payload },
      "hook",
    );
    assert.equal(code, 0); // never disturbs the agent
    assert.equal(stdout, ""); // a Stop hook's stdout is parsed as JSON — must be empty

    const got = (await fetch(`${server.url}/api/sessions/${session.id}/trace`).then((r) =>
      r.json(),
    )) as any;
    const kinds = got.steps.map((s: any) => s.kind);
    assert.deepEqual(kinds, ["prompt", "run", "prompt"]);
    assert.equal(got.steps[0].label, "draw me a card");
  } finally {
    await server.close();
  }
});

test("hook stays silent when no sideshow session owns the cwd", async () => {
  const server = await serveApp();
  try {
    const transcript = join(mkdtempSync(join(tmpdir(), "sideshow-tx-")), "t.jsonl");
    writeFileSync(
      transcript,
      `{"timestamp":"2026-06-18T00:00:00.000Z","message":{"role":"user","content":"hi"}}`,
    );
    const payload = JSON.stringify({
      hook_event_name: "Stop",
      transcript_path: transcript,
      cwd: "/tmp/no-such-sideshow-session",
    });
    const { code, stdout, stderr } = await runWith(
      { env: { SIDESHOW_URL: server.url }, stdin: payload },
      "hook",
    );
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  } finally {
    await server.close();
  }
});

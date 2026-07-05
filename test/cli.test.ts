import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
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
function testEnv(overrides?: Record<string, string>) {
  const env = { ...process.env };
  delete env.SIDESHOW_URL;
  delete env.SIDESHOW_SESSION;
  delete env.SIDESHOW_AGENT;
  delete env.SIDESHOW_TOKEN;
  return { ...env, ...overrides };
}

function runWith(
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string },
  ...args: string[]
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: opts.cwd, env: testEnv(opts.env) },
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
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            (
              server as typeof server & { closeAllConnections?: () => void }
            ).closeAllConnections?.();
          }),
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

const surfaceKinds = (out: any) => out.surfaces.map((s: any) => s.kind);

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
  "surface",
  "wait",
  "watch",
  "comment",
  "list",
  "show",
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

test("top-level help prints usage", async () => {
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const { code, stdout, stderr } = await run(...args);
    assert.equal(code, 0);
    assert.match(stdout, /usage:/);
    assert.equal(stderr, "");
  }
});

test("--help on a flag-less subcommand prints usage instead of running it", async () => {
  // would otherwise seed demo data (or fail reaching the server)
  const { code, stdout } = await run("demo", "--help");
  assert.equal(code, 0);
  assert.match(stdout, /usage:/);
});

test("unknown command fails with a one-line hint", async () => {
  const { code, stdout, stderr } = await run("bogus-command");
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /^sideshow: unknown command "bogus-command" — run "sideshow help"\n$/);
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
  let child: ChildProcess | undefined;
  let childExited = false;
  let childExit: Promise<void> = Promise.resolve();
  try {
    const session = await post(`${server.url}/api/sessions`, { agent: "e2e", title: "Watch" });
    const snippet = await post(`${server.url}/api/snippets`, {
      html: "<p>x</p>",
      title: "Doc",
      session: session.id,
    });

    child = spawn(process.execPath, [CLI, "watch"], {
      env: testEnv({ SIDESHOW_URL: server.url, SIDESHOW_SESSION: session.id }),
    });
    childExit = new Promise<void>((resolve) =>
      child?.once("exit", () => {
        childExited = true;
        resolve();
      }),
    );
    let stdout = "";
    child.stdout?.on("data", (d) => (stdout += d));

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
    if (child) {
      child.kill();
      await Promise.race([childExit, new Promise((resolve) => setTimeout(resolve, 1000))]);
      if (!childExited) child.kill("SIGKILL");
      await childExit;
    }
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

test("publish --kit puts the (deduped) kit ids on the html surface", async () => {
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

test("kits lists the workspace's available kits", async () => {
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

test("trace-sync posts transcript steps and then only sends the tail", async () => {
  const server = await serveSession();
  const cwd = mkdtempSync(join(tmpdir(), "sideshow-trace-sync-"));
  try {
    const transcript = join(cwd, "session.jsonl");
    writeFileSync(
      transcript,
      [
        `{"timestamp":"2026-06-18T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"build the visual"}]}}`,
        `{"timestamp":"2026-06-18T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Need a compact plan"},{"type":"text","text":"I'll inspect the files."},{"type":"tool_use","id":"r1","name":"Read","input":{"file_path":"/repo/src/app.ts"}},{"type":"tool_use","id":"todo","name":"TodoWrite","input":{"todos":[]}}]}}`,
        `{"timestamp":"2026-06-18T00:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"r1","content":[{"type":"text","text":"export const app = true;"}]}]}}`,
        `{"timestamp":"2026-06-18T00:00:03.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"w1","name":"WebSearch","input":{"query":"sideshow examples"}},{"type":"tool_use","id":"m1","name":"mcp__sideshow__publish_post","input":{"title":"Demo"}},{"type":"tool_use","id":"x1","name":"CustomTool","input":{"ok":true}}]}}`,
        `not json`,
      ].join("\n"),
    );

    const first = await runWith(
      { cwd, env: { SIDESHOW_URL: server.url, SIDESHOW_SESSION: server.session.id } },
      "trace-sync",
      "--transcript",
      transcript,
      "--all",
    );
    assert.equal(first.code, 0);
    const firstOut = JSON.parse(first.stdout);
    assert.equal(firstOut.added, 7);
    assert.equal(firstOut.reset, true);
    assert.equal(firstOut.windowed, false);

    const stored = (await fetch(`${server.url}/api/sessions/${server.session.id}/trace`).then((r) =>
      r.json(),
    )) as any;
    assert.deepEqual(
      stored.steps.map((s: any) => s.kind),
      ["prompt", "think", "say", "read", "web", "mcp", "customtool"],
    );
    assert.match(stored.steps.find((s: any) => s.kind === "read").detail, /export const app/);

    writeFileSync(
      transcript,
      readFileSync(transcript, "utf8") +
        `\n{"timestamp":"2026-06-18T00:00:04.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"g1","name":"Grep","input":{"pattern":"TODO"}}]}}`,
    );
    const second = await runWith(
      { cwd, env: { SIDESHOW_URL: server.url, SIDESHOW_SESSION: server.session.id } },
      "trace-sync",
      "--transcript",
      transcript,
      "--all",
    );
    assert.equal(second.code, 0);
    const secondOut = JSON.parse(second.stdout);
    assert.equal(secondOut.added, 1);
    assert.equal(secondOut.reset, false);
  } finally {
    await server.close();
  }
});

test("trace-sync --quiet still syncs while suppressing stdout", async () => {
  const server = await serveSession();
  const cwd = mkdtempSync(join(tmpdir(), "sideshow-trace-quiet-"));
  try {
    const transcript = join(cwd, "quiet.jsonl");
    writeFileSync(
      transcript,
      `{"timestamp":"2026-06-18T00:00:00.000Z","message":{"role":"user","content":"quiet sync"}}`,
    );
    const { code, stdout, stderr } = await runWith(
      { cwd, env: { SIDESHOW_URL: server.url, SIDESHOW_SESSION: server.session.id } },
      "trace-sync",
      "--transcript",
      transcript,
      "--all",
      "--quiet",
    );
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");

    const stored = (await fetch(`${server.url}/api/sessions/${server.session.id}/trace`).then((r) =>
      r.json(),
    )) as any;
    assert.deepEqual(
      stored.steps.map((s: any) => s.label),
      ["quiet sync"],
    );
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Core publish → comment → revise loop and the rich-surface commands.
// The CLI is a first-class integration tier ("agents with only a shell can use
// this"); these exercise the command bodies that hit the network.
// ---------------------------------------------------------------------------

// A throwaway file under a temp dir; returns its absolute path.
function tmpFile(name: string, content: string) {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-cli-file-"));
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

// Create a session on the test server and return { id, url, close, session }.
async function serveSession() {
  const server = await serveApp();
  const session = await post(`${server.url}/api/sessions`, { agent: "cli-test", title: "CLI" });
  return { ...server, session };
}

// Run a CLI command against a running server, pinning the session via env so
// state-file resolution never interferes across tests.
function cli(server: { url: string; session: { id: string } }, ...args: string[]) {
  return runWith(
    { env: { SIDESHOW_URL: server.url, SIDESHOW_SESSION: server.session.id } },
    ...args,
  );
}

// --- publish (html + combined surfaces) -----------------------------------

test("publish posts an html file and prints id + url + surface metadata", async () => {
  const server = await serveSession();
  try {
    const file = tmpFile("card.html", "<p>hello</p>");
    const { code, stdout } = await cli(server, "publish", file, "--title", "Card");
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.title, "Card");
    assert.equal(out.sessionId, server.session.id);
    assert.deepEqual(surfaceKinds(out), ["html"]);
    assert.equal(out.url, `${server.url}/p/${out.id}`);
    assert.equal(out.version, 1);
  } finally {
    await server.close();
  }
});

test("publish reads html from stdin with '-'", async () => {
  const server = await serveSession();
  try {
    const { code, stdout } = await runWith(
      {
        env: { SIDESHOW_URL: server.url, SIDESHOW_SESSION: server.session.id },
        stdin: "<p>piped</p>",
      },
      "publish",
      "-",
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.deepEqual(surfaceKinds(out), ["html"]);
    const full = (await fetch(`${server.url}/api/surfaces/${out.id}`).then((r) => r.json())) as any;
    assert.equal(full.surfaces[0].html, "<p>piped</p>");
  } finally {
    await server.close();
  }
});

test("publish combines html with --md, --code, --terminal, --mermaid surfaces in flag order", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<div>x</div>");
    const md = tmpFile("m.md", "# heading");
    const code = tmpFile("snippet.ts", "const x = 1;");
    const term = tmpFile("t.log", "$ echo hi");
    const mermaid = tmpFile("d.mmd", "graph TD; A-->B");
    const { code: exit, stdout } = await cli(
      server,
      "publish",
      html,
      "--md",
      md,
      "--code",
      code,
      "--terminal",
      term,
      "--mermaid",
      mermaid,
    );
    assert.equal(exit, 0);
    const out = JSON.parse(stdout);
    // Surfaces appear in the order their flags were passed on the command line.
    assert.deepEqual(surfaceKinds(out), ["html", "markdown", "code", "terminal", "mermaid"]);
  } finally {
    await server.close();
  }
});

test("publish surface order follows flag order, not a fixed sequence", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<div>x</div>");
    const md = tmpFile("m.md", "# heading");
    const code = tmpFile("snippet.ts", "const x = 1;");
    const mermaid = tmpFile("d.mmd", "graph TD; A-->B");

    // Same flags, different order → different surface order.
    const a = await cli(server, "publish", html, "--code", code, "--mermaid", mermaid, "--md", md);
    const b = await cli(server, "publish", html, "--md", md, "--mermaid", mermaid, "--code", code);
    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
    const outA = JSON.parse(a.stdout);
    const outB = JSON.parse(b.stdout);
    assert.deepEqual(surfaceKinds(outA), ["html", "code", "mermaid", "markdown"]);
    assert.deepEqual(surfaceKinds(outB), ["html", "markdown", "mermaid", "code"]);
  } finally {
    await server.close();
  }
});

test("publish surfaces with --terminal before --md produces terminal-then-markdown order", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<div>x</div>");
    const md = tmpFile("m.md", "# heading");
    const term = tmpFile("t.log", "$ echo hi");
    const { code: exit, stdout } = await cli(
      server,
      "publish",
      html,
      "--terminal",
      term,
      "--md",
      md,
    );
    assert.equal(exit, 0);
    const out = JSON.parse(stdout);
    assert.deepEqual(surfaceKinds(out), ["html", "terminal", "markdown"]);
  } finally {
    await server.close();
  }
});

test("publish repeats a surface flag to add several of the same kind, in order", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<div>x</div>");
    const a = tmpFile("a.patch", "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+aa\n");
    const b = tmpFile("b.patch", "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-b\n+bb\n");
    const code = tmpFile("c.ts", "const x = 1;");
    const { code: exit, stdout } = await cli(
      server,
      "publish",
      html,
      "--diff",
      a,
      "--code",
      code,
      "--diff",
      b,
    );
    assert.equal(exit, 0);
    const out = JSON.parse(stdout);
    // Two diff surfaces appear, with the code surface between them in argv order.
    assert.deepEqual(surfaceKinds(out), ["html", "diff", "code", "diff"]);
    const full = (await fetch(`${server.url}/api/surfaces/${out.id}`).then((r) => r.json())) as any;
    const diffs = full.surfaces.filter((s: any) => s.kind === "diff");
    assert.equal(diffs.length, 2);
    assert.deepEqual(
      diffs.map((s: any) => s.patch),
      [readFileSync(a, "utf8"), readFileSync(b, "utf8")],
    );
  } finally {
    await server.close();
  }
});

test("publish --code infers the language from the filename", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<p/>");
    const code = tmpFile("app.py", "print('hi')");
    const { stdout } = await cli(server, "publish", html, "--code", code);
    const out = JSON.parse(stdout);
    assert.deepEqual(surfaceKinds(out), ["html", "code"]);
    const full = (await fetch(`${server.url}/api/surfaces/${out.id}`).then((r) => r.json())) as any;
    const codeSurface = full.surfaces.find((s: any) => s.kind === "code");
    assert.equal(codeSurface.language, "python");
    assert.equal(codeSurface.title, "app.py");
  } finally {
    await server.close();
  }
});

test("publish --json with invalid JSON fails with a clear error", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<p/>");
    const bad = tmpFile("bad.json", "{not json");
    const { code, stderr } = await cli(server, "publish", html, "--json", bad);
    assert.notEqual(code, 0);
    assert.match(stderr, /--json: invalid JSON/);
  } finally {
    await server.close();
  }
});

test("publish --diff with --layout split carries the layout on the diff surface", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<p/>");
    const patch = tmpFile("p.patch", "--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n");
    const { stdout } = await cli(server, "publish", html, "--diff", patch, "--layout", "split");
    const out = JSON.parse(stdout);
    assert.deepEqual(surfaceKinds(out), ["html", "diff"]);
    const full = (await fetch(`${server.url}/api/surfaces/${out.id}`).then((r) => r.json())) as any;
    assert.equal(full.surfaces.find((s: any) => s.kind === "diff").layout, "split");
  } finally {
    await server.close();
  }
});

// --- single-surface commands (thin wrappers around the publish path) ------

test("diff publishes a diff-only post from a patch", async () => {
  const server = await serveSession();
  try {
    const patch = tmpFile("p.patch", "--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n");
    const { code, stdout } = await cli(server, "diff", patch, "--title", "Fix");
    assert.equal(code, 0);
    assert.deepEqual(surfaceKinds(JSON.parse(stdout)), ["diff"]);
  } finally {
    await server.close();
  }
});

test("markdown publishes a markdown-only post", async () => {
  const server = await serveSession();
  try {
    const md = tmpFile("m.md", "# hello\n\nbody");
    const { code, stdout } = await cli(server, "markdown", md);
    assert.equal(code, 0);
    assert.deepEqual(surfaceKinds(JSON.parse(stdout)), ["markdown"]);
  } finally {
    await server.close();
  }
});

test("code --line-start and --filename and --language are honored", async () => {
  const server = await serveSession();
  try {
    const src = tmpFile("x.txt", "a\nb\nc");
    const { code, stdout } = await cli(
      server,
      "code",
      src,
      "--filename",
      "src/lib.rs",
      "--language",
      "rust",
      "--line-start",
      "42",
    );
    assert.equal(code, 0);
    const full = (await fetch(`${server.url}/api/surfaces/${JSON.parse(stdout).id}`).then((r) =>
      r.json(),
    )) as any;
    const surface = full.surfaces[0];
    assert.equal(surface.kind, "code");
    assert.equal(surface.language, "rust");
    assert.equal(surface.title, "src/lib.rs");
    assert.equal(surface.lineStart, 42);
  } finally {
    await server.close();
  }
});

test("terminal --cols and --term-title are honored", async () => {
  const server = await serveSession();
  try {
    const t = tmpFile("t.log", "$ run\nok");
    const { code, stdout } = await cli(
      server,
      "terminal",
      t,
      "--cols",
      "120",
      "--term-title",
      "build",
    );
    assert.equal(code, 0);
    const full = (await fetch(`${server.url}/api/surfaces/${JSON.parse(stdout).id}`).then((r) =>
      r.json(),
    )) as any;
    const surface = full.surfaces[0];
    assert.equal(surface.kind, "terminal");
    assert.equal(surface.cols, 120);
    assert.equal(surface.title, "build");
  } finally {
    await server.close();
  }
});

test("json publishes a parsed JSON surface", async () => {
  const server = await serveSession();
  try {
    const f = tmpFile("d.json", '{"a": 1, "b": [2, 3]}');
    const { code, stdout } = await cli(server, "json", f);
    assert.equal(code, 0);
    const full = (await fetch(`${server.url}/api/surfaces/${JSON.parse(stdout).id}`).then((r) =>
      r.json(),
    )) as any;
    assert.equal(full.surfaces[0].kind, "json");
    assert.deepEqual(full.surfaces[0].data, { a: 1, b: [2, 3] });
  } finally {
    await server.close();
  }
});

test("json with invalid JSON fails with a clear error", async () => {
  const server = await serveSession();
  try {
    const f = tmpFile("bad.json", "{nope");
    const { code, stderr } = await cli(server, "json", f);
    assert.notEqual(code, 0);
    assert.match(stderr, /invalid JSON/);
  } finally {
    await server.close();
  }
});

test("mermaid publishes a mermaid-only post", async () => {
  const server = await serveSession();
  try {
    const m = tmpFile("d.mmd", "graph TD; A-->B");
    const { code, stdout } = await cli(server, "mermaid", m);
    assert.equal(code, 0);
    assert.deepEqual(surfaceKinds(JSON.parse(stdout)), ["mermaid"]);
  } finally {
    await server.close();
  }
});

test("trace publishes a trace asset post", async () => {
  const server = await serveSession();
  try {
    const trace = tmpFile(
      "trace.json",
      JSON.stringify({ steps: [{ kind: "run", label: "build" }] }),
    );
    const { code, stdout } = await cli(server, "trace", trace, "--title", "Trace");
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.deepEqual(surfaceKinds(out), ["trace"]);
    const full = (await fetch(`${server.url}/api/posts/${out.id}`).then((r) => r.json())) as any;
    assert.equal(full.surfaces[0].kind, "trace");
    assert.ok(full.surfaces[0].assetId);
  } finally {
    await server.close();
  }
});

// --- update (revise → new version, same card) -----------------------------

test("update revises a post to a new version on the same card", async () => {
  const server = await serveSession();
  try {
    const file = tmpFile("v1.html", "<p>v1</p>");
    const pub = await cli(server, "publish", file);
    const id = JSON.parse(pub.stdout).id;

    const next = tmpFile("v2.html", "<p>v2</p>");
    const { code, stdout } = await cli(server, "update", id, next, "--title", "Renamed");
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.id, id);
    assert.equal(out.version, 2);
    assert.equal(out.title, "Renamed");
  } finally {
    await server.close();
  }
});

test("update without an id fails with a usage error", async () => {
  const server = await serveSession();
  try {
    const { code, stderr } = await cli(server, "update");
    assert.notEqual(code, 0);
    assert.match(stderr, /usage: sideshow update/);
  } finally {
    await server.close();
  }
});

// --- surface subcommand (add / remove / edit / move) -----------------------

test("surface add appends a markdown surface to an existing post", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<p>first</p>");
    const pub = await cli(server, "publish", html);
    const id = JSON.parse(pub.stdout).id;

    const md = tmpFile("m.md", "# appended");
    const { code, stdout } = await cli(server, "surface", "add", id, "--md", md);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.deepEqual(surfaceKinds(out), ["html", "markdown"]);

    const full = (await fetch(`${server.url}/api/posts/${id}`).then((r) => r.json())) as any;
    assert.equal(full.surfaces[1].markdown, "# appended");
  } finally {
    await server.close();
  }
});

test("surface add appends a diff surface with --layout split", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<p>first</p>");
    const pub = await cli(server, "publish", html);
    const id = JSON.parse(pub.stdout).id;

    const patch = tmpFile("d.patch", "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n");
    const { code } = await cli(server, "surface", "add", id, "--diff", patch, "--layout", "split");
    assert.equal(code, 0);

    const full = (await fetch(`${server.url}/api/posts/${id}`).then((r) => r.json())) as any;
    assert.equal(full.surfaces[1].kind, "diff");
    assert.equal(full.surfaces[1].layout, "split", "layout split is propagated");
  } finally {
    await server.close();
  }
});

test("surface add repeats a flag to append several of the same kind, in order", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<p>first</p>");
    const pub = await cli(server, "publish", html);
    const id = JSON.parse(pub.stdout).id;

    const a = tmpFile("a.md", "# first append");
    const b = tmpFile("b.md", "# second append");
    const { code } = await cli(server, "surface", "add", id, "--md", a, "--md", b);
    assert.equal(code, 0);

    const full = (await fetch(`${server.url}/api/posts/${id}`).then((r) => r.json())) as any;
    assert.deepEqual(
      full.surfaces.map((s: any) => s.kind),
      ["html", "markdown", "markdown"],
    );
    assert.deepEqual(
      full.surfaces.slice(1).map((s: any) => s.markdown),
      ["# first append", "# second append"],
    );
  } finally {
    await server.close();
  }
});

test("surface remove deletes a surface by index", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<p>a</p>");
    const md = tmpFile("m.md", "# b");
    const pub = await cli(server, "publish", html, "--md", md);
    const id = JSON.parse(pub.stdout).id;

    const { code, stdout } = await cli(server, "surface", "remove", id, "1");
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.deepEqual(surfaceKinds(out), ["html"]);
  } finally {
    await server.close();
  }
});

test("surface edit replaces a surface's content by id", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<p>orig</p>");
    const md = tmpFile("m.md", "# orig md");
    const pub = await cli(server, "publish", html, "--md", md);
    const id = JSON.parse(pub.stdout).id;

    const full = (await fetch(`${server.url}/api/posts/${id}`).then((r) => r.json())) as any;
    const mdId = full.surfaces[1].id;

    const newMd = tmpFile("m2.md", "# updated md");
    const { code } = await cli(server, "surface", "edit", id, mdId, newMd);
    assert.equal(code, 0);

    const updated = (await fetch(`${server.url}/api/posts/${id}`).then((r) => r.json())) as any;
    assert.equal(updated.surfaces[1].markdown, "# updated md");
    assert.equal(updated.surfaces[0].html, "<p>orig</p>", "other surface untouched");
  } finally {
    await server.close();
  }
});

test("surface move reorders a surface by id", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<p>a</p>");
    const md = tmpFile("m.md", "# b");
    const code = tmpFile("c.ts", "const x = 1;");
    const pub = await cli(server, "publish", html, "--md", md, "--code", code);
    const id = JSON.parse(pub.stdout).id;

    const full = (await fetch(`${server.url}/api/posts/${id}`).then((r) => r.json())) as any;
    const mdId = full.surfaces[1].id;

    const { code: exitCode } = await cli(server, "surface", "move", id, mdId, "--to", "0");
    assert.equal(exitCode, 0);

    const updated = (await fetch(`${server.url}/api/posts/${id}`).then((r) => r.json())) as any;
    assert.deepEqual(
      updated.surfaces.map((s: any) => s.kind),
      ["markdown", "html", "code"],
    );
  } finally {
    await server.close();
  }
});

test("surface add without a surface flag fails before hitting the API", async () => {
  const { code, stdout, stderr } = await runWith(
    { env: { SIDESHOW_URL: "http://127.0.0.1:1", SIDESHOW_SESSION: "session123" } },
    "surface",
    "add",
    "post123",
  );
  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /provide at least one surface flag/);
});

test("surface move validates the source and target indexes", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<p>a</p>");
    const md = tmpFile("m.md", "# b");
    const id = JSON.parse((await cli(server, "publish", html, "--md", md)).stdout).id;

    const missing = await cli(server, "surface", "move", id, "no-such-surface", "--to", "0");
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /surface "no-such-surface" not found/);

    const badTarget = await cli(server, "surface", "move", id, "0", "--to", "9");
    assert.notEqual(badTarget.code, 0);
    assert.match(badTarget.stderr, /--to must be a valid index/);
  } finally {
    await server.close();
  }
});

test("unknown surface subcommand fails with the supported verbs", async () => {
  const { code, stderr } = await run("surface", "bogus");
  assert.notEqual(code, 0);
  assert.match(stderr, /unknown surface subcommand: bogus/);
});

// --- wait (blocking feedback long-poll) -----------------------------------

test("wait returns a pending user comment immediately", async () => {
  const server = await serveSession();
  try {
    const file = tmpFile("c.html", "<p>x</p>");
    const pub = await cli(server, "publish", file);
    const id = JSON.parse(pub.stdout).id;
    // a user comment is already waiting when wait runs
    await post(`${server.url}/api/comments`, { surface: id, text: "ship it", author: "user" });

    const { code, stdout } = await cli(server, "wait", "--timeout", "5");
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.comments.length, 1);
    assert.equal(out.comments[0].text, "ship it");
  } finally {
    await server.close();
  }
});

test("wait with no comments returns timedOut", async () => {
  const server = await serveSession();
  try {
    const { code, stdout } = await cli(server, "wait", "--timeout", "1");
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.timedOut, true);
    assert.deepEqual(out.comments, []);
  } finally {
    await server.close();
  }
});

test("wait --after with a non-number fails fast", async () => {
  const server = await serveSession();
  try {
    const { code, stderr } = await cli(server, "wait", "--after", "abc");
    assert.notEqual(code, 0);
    assert.match(stderr, /--after must be a number/);
  } finally {
    await server.close();
  }
});

// --- comment (agent replies to the user) ----------------------------------

test("comment replies on a post; --author overrides the default agent name", async () => {
  const server = await serveSession();
  try {
    const file = tmpFile("c.html", "<p>x</p>");
    const id = JSON.parse((await cli(server, "publish", file)).stdout).id;

    // default author falls back to "agent" when no --author/--agent/env is set
    const def = await cli(server, "comment", "on it", "--post", id);
    assert.equal(def.code, 0);
    assert.equal(JSON.parse(def.stdout).author, "agent");

    // --author sets the reply's author explicitly
    const named = await cli(server, "comment", "on it", "--post", id, "--author", "bot7");
    assert.equal(named.code, 0);
    const out = JSON.parse(named.stdout);
    assert.equal(out.text, "on it");
    assert.equal(out.postId, id);
    assert.equal(out.author, "bot7");
  } finally {
    await server.close();
  }
});

test("comment without --post fails with a usage error", async () => {
  const server = await serveSession();
  try {
    const { code, stderr } = await cli(server, "comment", "hello");
    assert.notEqual(code, 0);
    assert.match(stderr, /a comment must target a post/);
  } finally {
    await server.close();
  }
});

test("comment --surface is a back-compat alias for --post", async () => {
  const server = await serveSession();
  try {
    const file = tmpFile("c.html", "<p>x</p>");
    const id = JSON.parse((await cli(server, "publish", file)).stdout).id;
    const { code, stdout } = await cli(server, "comment", "via alias", "--surface", id);
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).postId, id);
  } finally {
    await server.close();
  }
});

// --- list / sessions ------------------------------------------------------

test("list prints the posts in the active session", async () => {
  const server = await serveSession();
  try {
    await cli(server, "publish", tmpFile("a.html", "<p>a</p>"), "--title", "A");
    await cli(server, "publish", tmpFile("b.html", "<p>b</p>"), "--title", "B");
    const { code, stdout } = await cli(server, "list");
    assert.equal(code, 0);
    const posts = JSON.parse(stdout);
    assert.equal(posts.length, 2);
    assert.deepEqual(
      posts.map((p: any) => p.title),
      ["A", "B"],
    );
  } finally {
    await server.close();
  }
});

test("list --all folds every session's posts into one dump", async () => {
  const server = await serveSession();
  try {
    await cli(server, "publish", tmpFile("a.html", "<p>a</p>"));
    // a second session, created directly via the API
    const other = await post(`${server.url}/api/sessions`, { agent: "other", title: "Other" });
    await post(`${server.url}/api/surfaces`, {
      parts: [{ kind: "html", html: "<p>z</p>" }],
      session: other.id,
      title: "Z",
    });

    const { code, stdout } = await cli(server, "list", "--all");
    assert.equal(code, 0);
    const sessions = JSON.parse(stdout);
    assert.equal(sessions.length, 2);
    assert.ok(sessions.some((s: any) => s.surfaces.some((p: any) => p.title === "Z")));
  } finally {
    await server.close();
  }
});

test("sessions prints the workspace's sessions", async () => {
  const server = await serveSession();
  try {
    const { code, stdout } = await cli(server, "sessions");
    assert.equal(code, 0);
    const sessions = JSON.parse(stdout);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, server.session.id);
  } finally {
    await server.close();
  }
});

test("show prints a single post with surface ids", async () => {
  const server = await serveSession();
  try {
    const html = tmpFile("h.html", "<p>a</p>");
    const md = tmpFile("m.md", "# b");
    const pub = await cli(server, "publish", html, "--md", md, "--title", "ShowMe");
    const id = JSON.parse(pub.stdout).id;

    const { code, stdout } = await cli(server, "show", id);
    assert.equal(code, 0);
    const post = JSON.parse(stdout);
    assert.equal(post.id, id);
    assert.equal(post.title, "ShowMe");
    assert.equal(post.surfaces.length, 2);
    assert.equal(post.surfaces[0].kind, "html");
    assert.equal(post.surfaces[1].kind, "markdown");
    assert.ok(post.surfaces[0].id, "surface ids are present");
    assert.ok(post.surfaces[1].id);
  } finally {
    await server.close();
  }
});

test("show without an id fails with a usage error", async () => {
  const { code, stderr } = await run("show");
  assert.notEqual(code, 0);
  assert.match(stderr, /usage: sideshow show/);
});

// --- assets (image / upload / asset-url) ----------------------------------

test("image uploads bytes and publishes an image post", async () => {
  const server = await serveSession();
  try {
    // minimal PNG header — the server only needs non-empty bytes; kind=image
    // is passed explicitly by the image command.
    const png = tmpFile(
      "pic.png",
      String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    );
    const { code, stdout } = await cli(server, "image", png, "--title", "Shot", "--caption", "hi");
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.deepEqual(surfaceKinds(out), ["image"]);
    const full = (await fetch(`${server.url}/api/surfaces/${out.id}`).then((r) => r.json())) as any;
    assert.equal(full.surfaces[0].caption, "hi");
    assert.ok(full.surfaces[0].assetId);
  } finally {
    await server.close();
  }
});

test("upload stores an asset and prints its id and url", async () => {
  const server = await serveSession();
  try {
    const png = tmpFile("up.png", String.fromCharCode(0x89, 0x50, 0x4e, 0x47));
    const { code, stdout } = await cli(server, "upload", png, "--kind", "image");
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.ok(out.id);
    assert.equal(out.url, `${server.url}/a/${out.id}`);
    assert.equal(out.kind, "image");
  } finally {
    await server.close();
  }
});

test("asset-url prints the content-hash id and url without hitting the server", async () => {
  const bytes = "asset-url-payload";
  const file = tmpFile("f.bin", bytes);
  const expected = createHash("sha256").update(bytes).digest("hex");
  // No server needed — asset-url is a pure local hash. Point BASE at a dummy.
  const { code, stdout } = await runWith(
    { env: { SIDESHOW_URL: "http://127.0.0.1:1" } },
    "asset-url",
    file,
  );
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.id, expected);
  assert.equal(out.url, `http://127.0.0.1:1/a/${expected}`);
});

test("guide commands fall back to bundled markdown when no server is reachable", async () => {
  for (const cmd of ["guide", "setup", "agent-howto"]) {
    const { code, stdout, stderr } = await runWith(
      { env: { SIDESHOW_URL: "http://127.0.0.1:1" } },
      cmd,
    );
    assert.equal(code, 0);
    assert.match(stdout, /#/);
    assert.equal(stderr, "");
  }
});

// --- error paths ----------------------------------------------------------

test("local file and usage errors fail before hitting the server", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), "sideshow-missing-file-")), "missing.html");
  const cases: Array<[string[], RegExp]> = [
    [["publish", missing], /cannot read file/],
    [["upload"], /usage: sideshow upload/],
    [["asset-url"], /usage: sideshow asset-url/],
    [["image"], /usage: sideshow image/],
    [["json"], /usage: sideshow json/],
    [["code"], /usage: sideshow code/],
    [["trace"], /usage: sideshow trace/],
  ];
  for (const [args, pattern] of cases) {
    const { code, stdout, stderr } = await runWith(
      { env: { SIDESHOW_URL: "http://127.0.0.1:1" } },
      ...args,
    );
    assert.notEqual(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, pattern);
  }
});

test("wait and list explain when there is no active session", async () => {
  for (const args of [["wait", "--timeout", "1"], ["list"]]) {
    const { code, stdout, stderr } = await runWith(
      {
        cwd: mkdtempSync(join(tmpdir(), "sideshow-no-session-")),
        env: { SIDESHOW_URL: "http://127.0.0.1:1" },
      },
      ...args,
    );
    assert.notEqual(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /no active session/);
  }
});

test("trace-sync explains missing session and missing transcript", async () => {
  const noSession = await runWith(
    {
      cwd: mkdtempSync(join(tmpdir(), "sideshow-no-session-")),
      env: { SIDESHOW_URL: "http://127.0.0.1:1" },
    },
    "trace-sync",
    "--transcript",
    "missing.jsonl",
  );
  assert.notEqual(noSession.code, 0);
  assert.match(noSession.stderr, /no active session/);

  const server = await serveSession();
  try {
    const missing = await cli(server, "trace-sync", "--transcript", "missing.jsonl");
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /no transcript found/);
  } finally {
    await server.close();
  }
});

test("an unreachable server fails with a one-line error, not a stack trace", async () => {
  const { code, stdout, stderr } = await runWith(
    { env: { SIDESHOW_URL: "http://127.0.0.1:1" } },
    "publish",
    tmpFile("x.html", "<p/>"),
  );
  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /^sideshow: server not reachable/);
});

test("a server error is surfaced as the server's error message", async () => {
  const server = await serveSession();
  try {
    // update a post that doesn't exist → 404 from the server
    const { code, stderr } = await cli(server, "update", "no-such-id", tmpFile("v.html", "<p/>"));
    assert.notEqual(code, 0);
    assert.match(stderr, /not found|no such/i);
  } finally {
    await server.close();
  }
});

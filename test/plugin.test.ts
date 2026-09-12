import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_HELPER = join(ROOT, "plugin", "scripts", "write-config.mjs");
const REMOVE_CONFIG_HELPER = join(ROOT, "plugin", "scripts", "remove-config.mjs");
const MONITOR_HELPER = join(ROOT, "plugin", "scripts", "run-monitor.mjs");

function runNode(script: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], { env }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

function cleanRoutingEnv() {
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.SIDESHOW_URL;
  delete env.SIDESHOW_TOKEN;
  return env;
}

function makeFakeNpx() {
  const directory = mkdtempSync(join(tmpdir(), "sideshow-plugin-npx-"));
  const fakeScript = join(directory, "fake-npx.cjs");
  writeFileSync(
    fakeScript,
    `const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_NPX_LOG, JSON.stringify({ args: process.argv.slice(2), url: process.env.SIDESHOW_URL, token: process.env.SIDESHOW_TOKEN }));
process.stdout.write("comment one\\ncomment two\\n");
process.stderr.write("watch diagnostic\\n");
process.exitCode = Number(process.env.FAKE_NPX_EXIT_CODE || 0);
`,
  );

  const posixNpx = join(directory, "npx");
  writeFileSync(posixNpx, `#!${process.execPath}\nrequire(${JSON.stringify(fakeScript)});\n`);
  chmodSync(posixNpx, 0o755);

  writeFileSync(
    join(directory, "npx.cmd"),
    `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`,
  );
  return directory;
}

async function writeConfig(
  dataDirectory: string,
  sessionId: string | undefined,
  sideshowUrl: string,
  apiToken: string,
) {
  const env: NodeJS.ProcessEnv = {
    ...cleanRoutingEnv(),
    CLAUDE_PLUGIN_DATA: dataDirectory,
    CLAUDE_PLUGIN_OPTION_SIDESHOWURL: sideshowUrl,
    CLAUDE_PLUGIN_OPTION_APITOKEN: apiToken,
  };
  if (sessionId) env.CLAUDE_CODE_SESSION_ID = sessionId;
  return runNode(CONFIG_HELPER, env);
}

test("Claude plugin monitor wiring passes only explicit non-secret routing arguments", () => {
  const monitors = JSON.parse(readFileSync(join(ROOT, "plugin", "monitors.json"), "utf8"));
  const monitorText = JSON.stringify(monitors);
  assert.doesNotMatch(monitorText, /\$\{user_config\./);
  assert.doesNotMatch(monitorText, /apiToken|SIDESHOW_TOKEN/i);
  assert.equal(
    monitors[0].command,
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/run-monitor.mjs" "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_CODE_SESSION_ID}"',
  );

  const manifest = JSON.parse(
    readFileSync(join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(manifest.version, "0.1.1");
  assert.equal(manifest.mcpServers.sideshow.env.SIDESHOW_URL, "${user_config.sideshowUrl}");
  assert.equal(manifest.mcpServers.sideshow.env.SIDESHOW_TOKEN, "${user_config.apiToken}");

  const hooks = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8"));
  const sessionStart = hooks.hooks.SessionStart[0];
  assert.match("startup", new RegExp(sessionStart.matcher));
  assert.match("resume", new RegExp(sessionStart.matcher));
  assert.match("fork", new RegExp(sessionStart.matcher));
  assert.doesNotMatch("compact", new RegExp(sessionStart.matcher));
  assert.doesNotMatch("clear", new RegExp(sessionStart.matcher));
  assert.equal(sessionStart.hooks[0].command, "node");
  assert.deepEqual(sessionStart.hooks[0].args, ["${CLAUDE_PLUGIN_ROOT}/scripts/write-config.mjs"]);

  const sessionEndHook = hooks.hooks.SessionEnd[0].hooks[0];
  assert.equal(sessionEndHook.command, "node");
  assert.deepEqual(sessionEndHook.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/remove-config.mjs"]);
});

test("SessionStart helper writes a private traversal-safe per-session config", async () => {
  const dataDirectory = join(mkdtempSync(join(tmpdir(), "sideshow-plugin-config-")), "data");
  const secret = "token-that-must-not-be-printed";
  const result = await writeConfig(
    dataDirectory,
    "../../unsafe/session-id",
    "https://sideshow.example.test",
    secret,
  );

  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  const files = readdirSync(dataDirectory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^monitor-config-[a-f0-9]{64}\.json$/);
  const configPath = join(dataDirectory, files[0]);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    sideshowUrl: "https://sideshow.example.test",
    apiToken: secret,
  });
  if (process.platform !== "win32") {
    assert.equal(statSync(dataDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  }
});

test("SessionEnd helper removes unconsumed configuration", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "sideshow-plugin-cleanup-"));
  const sessionId = "monitor-unavailable-session";
  assert.equal(
    (await writeConfig(dataDirectory, sessionId, "https://unused.example.test", "unused-token"))
      .code,
    0,
  );
  assert.equal(
    readdirSync(dataDirectory).filter((file) => file.startsWith("monitor-config-")).length,
    1,
  );

  const result = await runNode(REMOVE_CONFIG_HELPER, {
    ...cleanRoutingEnv(),
    CLAUDE_PLUGIN_DATA: dataDirectory,
    CLAUDE_CODE_SESSION_ID: sessionId,
  });

  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  assert.equal(
    readdirSync(dataDirectory).filter((file) => file.startsWith("monitor-config-")).length,
    0,
  );
});

test("monitor helper consumes explicit session config without exposing the token", async () => {
  const fakeBin = makeFakeNpx();
  const dataDirectory = mkdtempSync(join(tmpdir(), "sideshow-plugin-monitor-"));
  const logPath = join(dataDirectory, "npx.json");
  const sessionId = "session-explicit-arguments";
  const secret = "environment-only-token";
  assert.equal(
    (await writeConfig(dataDirectory, sessionId, "https://configured.example.test", secret)).code,
    0,
  );
  const [configFile] = readdirSync(dataDirectory);

  const result = await runNode(
    MONITOR_HELPER,
    {
      ...cleanRoutingEnv(),
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_NPX_EXIT_CODE: "7",
      FAKE_NPX_LOG: logPath,
    },
    [dataDirectory, sessionId],
  );

  assert.equal(result.code, 7);
  assert.equal(result.stdout, "comment one\ncomment two\n");
  assert.equal(result.stderr, "watch diagnostic\n");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
  const invocation = JSON.parse(readFileSync(logPath, "utf8"));
  assert.deepEqual(invocation.args, ["-y", "sideshow", "watch"]);
  assert.equal(invocation.url, "https://configured.example.test");
  assert.equal(invocation.token, secret);
  assert.doesNotMatch(JSON.stringify(invocation.args), new RegExp(secret));
  assert.equal(existsSync(join(dataDirectory, configFile)), false);
});

test("concurrent monitor sessions consume only their own credentials", async () => {
  const fakeBin = makeFakeNpx();
  const dataDirectory = mkdtempSync(join(tmpdir(), "sideshow-plugin-concurrent-"));
  const sessions = [
    {
      id: "session-a",
      url: "https://one.example.test",
      token: "token-one",
      log: join(dataDirectory, "one.json"),
    },
    {
      id: "session-b",
      url: "https://two.example.test",
      token: "token-two",
      log: join(dataDirectory, "two.json"),
    },
  ];

  await Promise.all(
    sessions.map(async ({ id, url, token }) => {
      assert.equal((await writeConfig(dataDirectory, id, url, token)).code, 0);
    }),
  );
  assert.equal(
    readdirSync(dataDirectory).filter((file) => file.startsWith("monitor-config-")).length,
    2,
  );

  const results = await Promise.all(
    sessions.map(({ id, log }) =>
      runNode(
        MONITOR_HELPER,
        {
          ...cleanRoutingEnv(),
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          FAKE_NPX_LOG: log,
        },
        [dataDirectory, id],
      ),
    ),
  );
  assert.deepEqual(
    results.map(({ code }) => code),
    [0, 0],
  );

  for (const { url, token, log } of sessions) {
    const invocation = JSON.parse(readFileSync(log, "utf8"));
    assert.equal(invocation.url, url);
    assert.equal(invocation.token, token);
    assert.deepEqual(invocation.args, ["-y", "sideshow", "watch"]);
  }
  assert.equal(
    readdirSync(dataDirectory).filter((file) => file.startsWith("monitor-config-")).length,
    0,
  );
});

test("config helpers use and consume a safe fallback when no session ID is available", async () => {
  const fakeBin = makeFakeNpx();
  const dataDirectory = mkdtempSync(join(tmpdir(), "sideshow-plugin-no-session-"));
  const logPath = join(dataDirectory, "npx.json");
  assert.equal(
    (await writeConfig(dataDirectory, undefined, "https://fallback.example.test", "fallback-token"))
      .code,
    0,
  );
  assert.equal(existsSync(join(dataDirectory, "monitor-config.json")), true);

  const result = await runNode(
    MONITOR_HELPER,
    {
      ...cleanRoutingEnv(),
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_NPX_LOG: logPath,
    },
    [dataDirectory, ""],
  );

  assert.equal(result.code, 0);
  const invocation = JSON.parse(readFileSync(logPath, "utf8"));
  assert.equal(invocation.url, "https://fallback.example.test");
  assert.equal(invocation.token, "fallback-token");
  assert.equal(existsSync(join(dataDirectory, "monitor-config.json")), false);
});

test("monitor helper waits briefly for its SessionStart configuration", async () => {
  const fakeBin = makeFakeNpx();
  const dataDirectory = mkdtempSync(join(tmpdir(), "sideshow-plugin-race-"));
  const logPath = join(dataDirectory, "npx.json");
  const sessionId = "waiting-session";
  const resultPromise = runNode(
    MONITOR_HELPER,
    {
      ...cleanRoutingEnv(),
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_NPX_LOG: logPath,
    },
    [dataDirectory, sessionId],
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    (await writeConfig(dataDirectory, sessionId, "https://race.example.test", "race-token")).code,
    0,
  );

  assert.equal((await resultPromise).code, 0);
  const invocation = JSON.parse(readFileSync(logPath, "utf8"));
  assert.equal(invocation.url, "https://race.example.test");
  assert.equal(invocation.token, "race-token");
  assert.equal(
    readdirSync(dataDirectory).filter((file) => file.startsWith("monitor-config-")).length,
    0,
  );
});

test("monitor helper preserves inherited configuration when no config arrives", async () => {
  const fakeBin = makeFakeNpx();
  const directory = mkdtempSync(join(tmpdir(), "sideshow-plugin-fallback-"));
  const logPath = join(directory, "npx.json");
  const result = await runNode(
    MONITOR_HELPER,
    {
      ...cleanRoutingEnv(),
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_NPX_LOG: logPath,
      SIDESHOW_URL: "http://localhost:8228",
      SIDESHOW_TOKEN: "inherited-token",
    },
    ["", "fallback-session"],
  );

  assert.equal(result.code, 0);
  const invocation = JSON.parse(readFileSync(logPath, "utf8"));
  assert.equal(invocation.url, "http://localhost:8228");
  assert.equal(invocation.token, "inherited-token");
});

test("monitor helper leaves localhost selection to the CLI when no config exists", async () => {
  const fakeBin = makeFakeNpx();
  const directory = mkdtempSync(join(tmpdir(), "sideshow-plugin-localhost-"));
  const logPath = join(directory, "npx.json");
  const result = await runNode(
    MONITOR_HELPER,
    {
      ...cleanRoutingEnv(),
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_NPX_LOG: logPath,
    },
    ["", "localhost-session"],
  );

  assert.equal(result.code, 0);
  const invocation = JSON.parse(readFileSync(logPath, "utf8"));
  assert.equal(invocation.url, undefined);
  assert.equal(invocation.token, undefined);
});

test("monitor helper reports spawn failure as exit code 1", async () => {
  const emptyPath = mkdtempSync(join(tmpdir(), "sideshow-plugin-empty-path-"));
  const result = await runNode(
    MONITOR_HELPER,
    {
      ...cleanRoutingEnv(),
      PATH: emptyPath,
      ComSpec: join(emptyPath, "missing-command-shell.exe"),
    },
    ["", "spawn-failure-session"],
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /sideshow monitor failed to start:/);
});

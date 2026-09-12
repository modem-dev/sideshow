import { spawn, spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { monitorConfigFile } from "./monitor-config.mjs";

const CONFIG_WAIT_MS = 1000;
const RETRY_MS = 25;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readConfig(dataDir, sessionId) {
  if (!dataDir) return null;

  const configPath = join(dataDir, monitorConfigFile(sessionId));
  const deadline = Date.now() + CONFIG_WAIT_MS;

  do {
    try {
      const text = await readFile(configPath, "utf8");
      await rm(configPath);
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // The atomic SessionStart writer may not have run yet. Retry briefly,
      // then preserve inherited SIDESHOW_* values and the CLI's localhost default.
    }
    await sleep(RETRY_MS);
  } while (Date.now() < deadline);

  return null;
}

const dataDir = process.argv[2] || process.env.CLAUDE_PLUGIN_DATA;
const sessionId = process.argv[3] || process.env.CLAUDE_CODE_SESSION_ID;
const childEnv = { ...process.env };
let config;
try {
  config = await readConfig(dataDir, sessionId);
} catch (error) {
  console.error(`sideshow monitor configuration failed: ${error.message}`);
  process.exit(1);
}

if (config) {
  if (typeof config.sideshowUrl === "string" && config.sideshowUrl) {
    childEnv.SIDESHOW_URL = config.sideshowUrl;
  }
  if (typeof config.apiToken === "string" && config.apiToken) {
    childEnv.SIDESHOW_TOKEN = config.apiToken;
  } else {
    delete childEnv.SIDESHOW_TOKEN;
  }
}

const executable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npx";
const args =
  process.platform === "win32"
    ? ["/d", "/s", "/c", "npx -y sideshow watch"]
    : ["-y", "sideshow", "watch"];
const child = spawn(executable, args, {
  detached: process.platform !== "win32",
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

let shutdownSignal;
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];

function terminateChild(signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    // npx is behind cmd.exe on Windows. Terminate the complete process tree so
    // the long-running watch process cannot outlive this monitor helper.
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back if the platform did not create the requested process group.
    }
  }
  child.kill(signal);
}

for (const signal of signals) {
  process.on(signal, () => {
    if (shutdownSignal) return;
    shutdownSignal = signal;
    terminateChild(signal);
  });
}

process.on("exit", () => terminateChild());

let spawnFailed = false;
child.on("error", (error) => {
  spawnFailed = true;
  console.error(`sideshow monitor failed to start: ${error.message}`);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  if (spawnFailed) {
    process.exitCode = 1;
    return;
  }
  if (shutdownSignal || signal) {
    const forwardedSignal = shutdownSignal ?? signal;
    if (process.platform !== "win32" && forwardedSignal) {
      for (const handledSignal of signals) process.removeAllListeners(handledSignal);
      process.kill(process.pid, forwardedSignal);
      return;
    }
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

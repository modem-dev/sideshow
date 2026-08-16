import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { monitorConfigFile } from "./monitor-config.mjs";

async function replaceFile(tempPath, configPath) {
  try {
    await rename(tempPath, configPath);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      (error.code !== "EEXIST" && error.code !== "EPERM" && error.code !== "EACCES")
    ) {
      throw error;
    }

    // Node does not expose Windows' atomic replace-file primitive. Keep the
    // same-directory rename path everywhere, with this replacement fallback
    // for an existing destination on Windows.
    await rm(configPath, { force: true });
    await rename(tempPath, configPath);
  }
}

export async function writeMonitorConfig(env = process.env) {
  const dataDir = env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) throw new Error("CLAUDE_PLUGIN_DATA is not set");

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dataDir, 0o700);

  const configFile = monitorConfigFile(env.CLAUDE_CODE_SESSION_ID);
  const configPath = join(dataDir, configFile);
  const tempPath = join(dataDir, `.${configFile}.${process.pid}.${randomBytes(6).toString("hex")}`);
  const config = {
    sideshowUrl: env.CLAUDE_PLUGIN_OPTION_SIDESHOWURL ?? "",
    apiToken: env.CLAUDE_PLUGIN_OPTION_APITOKEN ?? "",
  };

  try {
    await writeFile(tempPath, `${JSON.stringify(config)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await replaceFile(tempPath, configPath);
    if (process.platform !== "win32") await chmod(configPath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

try {
  await writeMonitorConfig();
} catch (error) {
  console.error(`sideshow plugin configuration failed: ${error.message}`);
  process.exitCode = 1;
}

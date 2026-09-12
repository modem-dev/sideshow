import { rm } from "node:fs/promises";
import { join } from "node:path";

import { monitorConfigFile } from "./monitor-config.mjs";

export async function removeMonitorConfig(env = process.env) {
  const dataDir = env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) return;
  await rm(join(dataDir, monitorConfigFile(env.CLAUDE_CODE_SESSION_ID)), { force: true });
}

try {
  await removeMonitorConfig();
} catch (error) {
  console.error(`sideshow plugin configuration cleanup failed: ${error.message}`);
  process.exitCode = 1;
}

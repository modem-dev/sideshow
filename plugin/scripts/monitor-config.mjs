import { createHash } from "node:crypto";

const FALLBACK_CONFIG_FILE = "monitor-config.json";

export function monitorConfigFile(sessionId) {
  if (!sessionId) return FALLBACK_CONFIG_FILE;
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return `monitor-config-${digest}.json`;
}

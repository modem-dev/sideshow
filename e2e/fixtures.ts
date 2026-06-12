import { test as base } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Each test gets its own sideshow server on an ephemeral port with a fresh
// data file, so tests can mutate state freely and run in parallel.
export const test = base.extend<{ server: { url: string } }>({
  // oxlint-disable-next-line no-empty-pattern
  server: async ({}, use) => {
    const dataDir = mkdtempSync(join(tmpdir(), "sideshow-e2e-"));
    const proc: ChildProcess = spawn(process.execPath, ["server/index.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        PORT: "0",
        SIDESHOW_DATA: join(dataDir, "data.json"),
        SIDESHOW_TOKEN: "",
        // empty = no version = no update check: keeps tests off the network
        // and the update banner out of the DOM
        SIDESHOW_VERSION: "",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const match = out.match(/listening on (http:\/\/localhost:\d+)/);
        if (match) resolve(match[1]);
      });
      proc.on("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
      setTimeout(() => reject(new Error(`server did not boot in time; output: ${out}`)), 15_000);
    });
    await use({ url });
    proc.kill();
  },
});

export { expect } from "@playwright/test";

export async function publish(
  serverUrl: string,
  body: { html: string; title?: string; agent?: string; session?: string },
): Promise<{ id: string; sessionId: string; version: number }> {
  const res = await fetch(`${serverUrl}/api/snippets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`publish failed: ${res.status}`);
  return res.json() as Promise<{ id: string; sessionId: string; version: number }>;
}

export async function update(
  serverUrl: string,
  id: string,
  body: { html?: string; title?: string },
): Promise<void> {
  const res = await fetch(`${serverUrl}/api/snippets/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update failed: ${res.status}`);
}

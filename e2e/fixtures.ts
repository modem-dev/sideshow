import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

type ServerHandle = { url: string; stop: () => void };

type PublicReadServer = { url: string; token: string; mode: "full" | "session" };

export async function startSideshowServer(
  env: Record<string, string | undefined> = {},
): Promise<ServerHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), "sideshow-e2e-"));
  const proc: ChildProcess = spawn(process.execPath, ["server/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: "0",
      SIDESHOW_DATA: join(dataDir, "data.json"),
      // empty = no version = no update check: keeps tests off the network
      // and the update banner out of the DOM
      SIDESHOW_VERSION: "",
      ...env,
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
  return { url, stop: () => proc.kill() };
}

// Each test gets its own sideshow server on an ephemeral port with a fresh
// data file, so tests can mutate state freely and run in parallel.
export const test = base.extend<{ server: { url: string } }>({
  // oxlint-disable-next-line no-empty-pattern
  server: async ({}, use) => {
    const server = await startSideshowServer({ SIDESHOW_TOKEN: "" });
    try {
      await use({ url: server.url });
    } finally {
      server.stop();
    }
  },
});

export const publicReadTest = base.extend<{ publicReadServer: PublicReadServer }>({
  // oxlint-disable-next-line no-empty-pattern
  publicReadServer: async ({}, use) => {
    const token = "secret";
    const mode = "full";
    const server = await startSideshowServer({ SIDESHOW_TOKEN: token, SIDESHOW_PUBLIC_READ: mode });
    try {
      await use({ url: server.url, token, mode });
    } finally {
      server.stop();
    }
  },
});

export { expect };

export async function publish(
  serverUrl: string,
  body: { html: string; title?: string; agent?: string; session?: string },
  token?: string,
): Promise<{ id: string; sessionId: string; version: number }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${serverUrl}/api/snippets`, {
    method: "POST",
    headers,
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

// A 1x1 transparent PNG, base64 — small enough to inline in a test.
export const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function upload(
  serverUrl: string,
  body: { data: string; contentType: string; filename?: string; kind?: string; session?: string },
): Promise<{ id: string; sessionId: string; url: string; kind: string }> {
  const res = await fetch(`${serverUrl}/api/assets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return res.json() as Promise<{ id: string; sessionId: string; url: string; kind: string }>;
}

export async function publishParts(
  serverUrl: string,
  body: { title?: string; parts: unknown[]; agent?: string; session?: string },
): Promise<{ id: string; sessionId: string; version: number }> {
  const res = await fetch(`${serverUrl}/api/surfaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`publishParts failed: ${res.status}`);
  return res.json() as Promise<{ id: string; sessionId: string; version: number }>;
}

export async function expectNoHorizontalOverflow(page: Page, selector: string) {
  await expect.poll(() => page.locator(selector).count()).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page
        .locator(selector)
        .evaluateAll((elements) =>
          Math.max(0, ...elements.map((el) => Math.ceil(el.scrollWidth - el.clientWidth))),
        ),
    )
    .toBeLessThanOrEqual(1);
}

export async function expectIframesNoHorizontalOverflow(page: Page, container: Locator) {
  const frameUrls = await container
    .locator("iframe")
    .evaluateAll((frames) => frames.map((frame) => (frame as HTMLIFrameElement).src));
  expect(frameUrls.length).toBeGreaterThan(0);

  await expect
    .poll(async () => {
      const childFrames = frameUrls
        .map((url) => page.frames().find((frame) => frame.url() === url))
        .filter((frame) => frame !== undefined);
      if (childFrames.length < frameUrls.length) return Number.POSITIVE_INFINITY;
      const overflows = await Promise.all(
        childFrames.map((frame) =>
          frame.evaluate(() => {
            if (document.readyState === "loading") return Number.POSITIVE_INFINITY;
            const doc = document.documentElement;
            const body = document.body;
            const scrollWidth = Math.max(doc.scrollWidth, body?.scrollWidth ?? 0);
            const clientWidth = Math.max(doc.clientWidth, body?.clientWidth ?? 0);
            return Math.ceil(scrollWidth - clientWidth);
          }),
        ),
      );
      return Math.max(0, ...overflows);
    })
    .toBeLessThanOrEqual(1);
}

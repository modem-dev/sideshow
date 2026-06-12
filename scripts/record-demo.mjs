// Records the README demo clip: boots a fresh server, replays the
// "Auth refactor" demo session (publish → live appear → user comment →
// v2 update → agent reply) in a video-recording Chromium, and prints the
// path of the captured webm. Convert with ffmpeg, e.g.:
//
//   node scripts/record-demo.mjs
//   ffmpeg -y -i <printed path> -vf "fps=12,scale=880:-1:flags=lanczos,\
//     split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=\
//     dither=bayer:bayer_scale=5:diff_mode=rectangle" docs/sideshow-demo.gif

import { chromium } from "@playwright/test";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_SESSIONS } from "../bin/demoData.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

execSync("npx vite build", { cwd: ROOT, stdio: "inherit" });
const dataDir = mkdtempSync(join(tmpdir(), "sideshow-rec-"));
const proc = spawn(process.execPath, [join(ROOT, "server", "index.ts")], {
  env: { ...process.env, PORT: "0", SIDESHOW_DATA: join(dataDir, "data.json") },
  stdio: ["ignore", "pipe", "inherit"],
});
const base = await new Promise((resolve, reject) => {
  let out = "";
  proc.stdout.on("data", (chunk) => {
    out += chunk;
    const m = out.match(/listening on (http:\/\/localhost:\d+)/);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error("server did not boot")), 10_000);
});

const api = (path, body, init = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  }).then((r) => r.json());

const demo = DEMO_SESSIONS.find((d) => d.title === "Auth refactor");
const snip = demo.snippets[0];
const [userComment, v2, agentReply] = snip.followups;

const size = { width: 1180, height: 740 };
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: size,
  recordVideo: { dir: dataDir, size },
  colorScheme: "light",
});
const page = await context.newPage();
await page.goto(base);
await sleep(1300);

// the agent publishes — the card streams in live
const session = await api("/api/sessions", { agent: demo.agent, title: demo.title });
await sleep(600);
const snippet = await api("/api/snippets", {
  session: session.id,
  title: snip.title,
  html: snip.html,
});
await page.locator(".card iframe").waitFor();
await sleep(2200);

// the user asks a question under it
const input = page.locator(".composer input");
await input.click();
await input.pressSequentially(userComment.comment.text, { delay: 36 });
await sleep(350);
await input.press("Enter");
await page.locator(".cmt").first().waitFor();
await sleep(1500);

// the agent revises the snippet (v2) and replies in the thread
await api(`/api/snippets/${snippet.id}`, v2.update, { method: "PUT" });
await page.locator("select.vbadge").waitFor();
await sleep(1400);
await api("/api/comments", { snippet: snippet.id, ...agentReply.comment });
await page.locator(".cmt").nth(1).waitFor();
await sleep(3000);

const video = page.video();
await context.close();
await browser.close();
proc.kill();
console.log(await video.path());

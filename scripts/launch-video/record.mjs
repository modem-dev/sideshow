// Records a sideshow release/feature video in one real-time pass: boots a
// fresh server, loads the live viewer inside the 1920x1080 stage
// (stage.html: window chrome + captions + title cards), drives the storyboard
// below with Playwright while recording video, and prints the raw webm path.
//
//   node scripts/launch-video/record.mjs
//   # then encode (see skills/launch-video/SKILL.md):
//   ffmpeg -y -i .video-work/raw.webm -vf "fps=30,format=yuv420p" \
//     -c:v libx264 -preset slow -crf 18 -movflags +faststart .video-work/release.mp4
//
// The storyboard (SCENES below + the cards/captions) is editorial content for
// one video — rewrite it per release. The stage + boot/seed/record machinery
// is reusable.

import { chromium } from "@playwright/test";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DEMO_SESSIONS } from "../../bin/demoData.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORK = process.argv[2] ?? join(ROOT, ".video-work");
mkdirSync(WORK, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- viewer build + server boot ---------------------------------------------

if (!existsSync(join(ROOT, "viewer", "dist", "index.html"))) {
  execSync("npm run build:viewer", { cwd: ROOT, stdio: "inherit" });
}

const proc = spawn(process.execPath, [join(ROOT, "server", "index.ts")], {
  env: { ...process.env, PORT: "0", SIDESHOW_DB: join(WORK, `rec-${Date.now()}.db`) },
  stdio: ["ignore", "pipe", "inherit"],
});
const base = await new Promise((resolve, reject) => {
  let out = "";
  proc.stdout.on("data", (chunk) => {
    out += chunk;
    const m = out.match(/listening on (http:\/\/localhost:\d+)/);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error("server did not boot")), 15_000);
});

const api = (path, body, init = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  }).then(async (r) => {
    const json = await r.json();
    if (!r.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
    return json;
  });

// --- seed --------------------------------------------------------------------

// Background session (gives the sidebar a second entry to switch to).
const queueDemo = DEMO_SESSIONS.find((d) => d.title === "Queue profiling");
const queueSession = await api("/api/sessions", { agent: queueDemo.agent, title: queueDemo.title });
for (const snip of queueDemo.snippets) {
  await api("/api/posts", {
    session: queueSession.id,
    title: snip.title,
    surfaces: [{ kind: "html", html: snip.html }],
  });
}

// Foreground session — starts empty; posts stream in on camera.
const authDemo = DEMO_SESSIONS.find((d) => d.title === "Auth refactor");
const [jwt, backoff] = authDemo.snippets;
const [userComment, v2, agentReply] = jwt.followups;
const session = await api("/api/sessions", { agent: authDemo.agent, title: authDemo.title });

// --- stage + browser ---------------------------------------------------------

// Optional caption fonts (npm i @fontsource-variable/inter @fontsource/jetbrains-mono
// in the work dir); the stage falls back to system fonts when absent.
const font = (rel) => {
  const p = join(WORK, "node_modules", rel);
  return existsSync(p) ? pathToFileURL(p).href : "about:blank";
};
const stageHtml = readFileSync(join(ROOT, "scripts", "launch-video", "stage.html"), "utf8")
  .replaceAll("__INTER__", font("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"))
  .replaceAll(
    "__MONO__",
    font("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2"),
  )
  .replaceAll("__APP_URL__", base)
  .replaceAll("__APP_HOST__", base.replace(/^https?:\/\//, ""));
const stagePath = join(WORK, "stage.resolved.html");
writeFileSync(stagePath, stageHtml);

const executablePath =
  process.env.CHROMIUM_PATH ??
  (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch({
  executablePath,
  args: ["--allow-file-access-from-files"],
});
const size = { width: 1920, height: 1080 };
const context = await browser.newContext({
  viewport: size,
  recordVideo: { dir: WORK, size },
  colorScheme: "dark",
});
// The viewer document sends `frame-ancestors 'self'` (clickjacking hardening),
// which would refuse the file:// stage's iframe — strip CSP on that one
// response for the recording. Never intercept /api/events (SSE would buffer).
await context.route(`${base}/`, async (route) => {
  const response = await route.fetch();
  const headers = { ...response.headers() };
  delete headers["content-security-policy"];
  await route.fulfill({ response, headers });
});

const page = await context.newPage();
await page.goto(pathToFileURL(stagePath).href);
const app = page.frameLocator("#app");
const stage = (fn, arg) => page.evaluate(([f, a]) => window.stage[f](a), [fn, arg]);

// --- storyboard --------------------------------------------------------------

// 1. Intro card (covers the viewer while it boots + selects the session).
await stage(
  "card",
  `
  <div class="badge">RELEASE</div>
  <h1>sideshow <span class="ver">0.13.0</span></h1>
  <p class="sub">a live visual surface for your coding agents</p>`,
);
await app.locator("aside .sess").first().waitFor();
await app.locator("aside .sess-title", { hasText: authDemo.title }).click();
await sleep(3200);

// 2. Publish → cards stream in live.
await stage("hideCard");
await sleep(700);
await stage(
  "caption",
  `Agents publish over <span class="hl">CLI, MCP, or plain HTTP</span> — cards render live in your browser`,
);
await sleep(900);
const post = await api("/api/posts", {
  session: session.id,
  title: jwt.title,
  surfaces: [{ kind: "html", html: jwt.html }],
});
await app.locator(".card:not(#whatsNew) iframe").first().waitFor();
await sleep(2600);
await api("/api/posts", {
  session: session.id,
  title: backoff.title,
  surfaces: [{ kind: "html", html: backoff.html }],
});
await sleep(2600);

// 3. The feedback loop: user comments, agent revises + replies.
await stage(
  "caption",
  `Comment on a card — <span class="hl">your agent gets it</span>, revises, and replies`,
);
await sleep(800);
const firstCard = app.locator(".card:not(#whatsNew)", { hasText: jwt.title });
await firstCard.scrollIntoViewIfNeeded();
const input = firstCard.locator(".composer input");
if (!(await input.isVisible().catch(() => false))) {
  // The composer is folded behind the card-footer comment icon button.
  await firstCard.locator("button.act.comment").click();
}
await input.click();
await input.pressSequentially(userComment.comment.text, { delay: 34 });
await sleep(400);
await input.press("Enter");
await sleep(1300);
await api(
  `/api/posts/${post.id}`,
  { surfaces: [{ kind: "html", html: v2.update.html }] },
  { method: "PUT" },
);
await sleep(1500);
await api("/api/comments", { surface: post.id, ...agentReply.comment });
await sleep(2400);

// 4. NEW in 0.13.0 — sidebar rail.
await stage(
  "caption",
  `<span class="badge">NEW</span> <span>Collapse the sidebar into a narrow rail — more room for the work</span>`,
);
await sleep(900);
await app.locator(".sidebar-toggle").click();
await sleep(2200);
await app.locator(".sidebar-toggle").click();
await sleep(1200);

// 5. Perf: switching sessions is light now.
await stage(
  "caption",
  `Sessions hydrate <span class="hl">up to 95% lighter</span>, on indexed SQLite hot paths`,
);
await sleep(700);
await app.locator("aside .sess-title", { hasText: queueDemo.title }).click();
await page.mouse.move(960, 720); // park the pointer so no sidebar hover state shows
await sleep(2600);
await app.locator("aside .sess-title", { hasText: authDemo.title }).click();
await page.mouse.move(960, 720);
// Hold until the sandboxed surface iframes have re-rendered, so the last
// live shot before the outro shows real content, not still-loading frames.
await app.locator(".card:not(#whatsNew) iframe").first().waitFor();
await sleep(3000);

// 6. Outro card.
await stage("caption", ``);
await stage(
  "card",
  `
  <h1>sideshow <span class="ver">0.13.0</span></h1>
  <div class="cmds">
    <div class="cmd"><span class="p">$</span> npm i -g sideshow</div>
    <div class="cmd"><span class="p">$</span> sideshow serve --open</div>
  </div>
  <p class="foot">github.com/modem-dev/sideshow</p>`,
);
await sleep(4200);

// --- finish ------------------------------------------------------------------

const video = page.video();
await context.close();
await browser.close();
proc.kill();
const raw = await video.path();
console.log(raw);

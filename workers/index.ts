import { DurableObject } from "cloudflare:workers";
import agentHowtoText from "../guide/AGENT_HOWTO.md";
import setupText from "../guide/AGENT_SETUP.md";
import guideMarkdown from "../guide/DESIGN_GUIDE.md";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "../server/app.ts";
import viewerHtml from "../viewer/dist/index.html";
import { SqlStore } from "./sqlStore.ts";

interface Env {
  BOARD: DurableObjectNamespace<SideshowBoard>;
  BROWSER: BrowserRun;
  SIDESHOW_TOKEN?: string;
  SIDESHOW_PUBLIC_READ?: string;
}

// The whole app lives inside one Durable Object: a single instance per board
// means the in-memory event bus is authoritative — SSE and long-poll work
// exactly as they do locally, with SQLite-in-DO as the store.
export class SideshowBoard extends DurableObject<Env> {
  private app: ReturnType<typeof createApp>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const pr = env.SIDESHOW_PUBLIC_READ;
    const publicRead = pr === "session" || pr === "full" ? pr : undefined;
    this.app = createApp({
      store: new SqlStore(ctx.storage.sql),
      viewerHtml,
      guideMarkdown,
      setupText,
      agentHowtoText,
      authToken: env.SIDESHOW_TOKEN,
      publicRead,
      version: pkg.version,
      upgradeCommand: "git pull && npm run deploy",
    });
  }

  override fetch(request: Request) {
    return this.app.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (!env.SIDESHOW_TOKEN) {
      return new Response(
        "sideshow is not configured: set a token first —\n\n  wrangler secret put SIDESHOW_TOKEN\n",
        { status: 503 },
      );
    }
    const board = env.BOARD.get(env.BOARD.idFromName("default"));

    // Screenshot: GET /s/:id.png → PNG of the rendered surface page.
    // Auth is decided by the app — we forward the user's credentials to the DO
    // and only proceed if it returns 200.
    const url = new URL(request.url);
    const pngMatch = request.method === "GET" && url.pathname.match(/^\/s\/([a-z0-9]+)\.png$/);
    if (!pngMatch) return board.fetch(request);

    // Let the app decide auth: forward the request (with user cookies/headers)
    // to the real /s/:id route. We pass theme/mode so the rendered page matches
    // what the viewer shows; the width is configurable via ?w= (default 800).
    const width = Math.min(Math.max(Number(url.searchParams.get("w")) || 800, 320), 1920);
    const theme = url.searchParams.get("theme");
    const modeParam = url.searchParams.get("mode");
    const modeCookie = request.headers.get("cookie")?.match(/sideshow_mode=(light|dark)/)?.[1];
    const mode =
      modeParam === "dark" || modeParam === "light"
        ? modeParam
        : (modeCookie as "light" | "dark" | undefined);
    const noCache = url.searchParams.has("nocache");

    const checkUrl = new URL(url);
    checkUrl.pathname = `/s/${pngMatch[1]}`;
    checkUrl.search = ""; // clear .png query params
    checkUrl.searchParams.set("part", "0");
    if (theme) checkUrl.searchParams.set("theme", theme);
    if (mode) checkUrl.searchParams.set("mode", mode);
    const checkRes = await board.fetch(new Request(checkUrl, { headers: request.headers }));
    if (!checkRes.ok) return checkRes;
    // Auth passed and surface exists — discard the HTML, take a screenshot.
    await checkRes.arrayBuffer();

    const target = checkUrl.toString();
    const screenshot = await env.BROWSER.quickAction("screenshot", {
      url: target,
      viewport: { width, height: 800 },
      screenshotOptions: { fullPage: true },
      gotoOptions: { waitUntil: "networkidle0", timeout: 15000 },
      cacheTTL: 0,
      cookies: [{ name: "sideshow_key", value: env.SIDESHOW_TOKEN, domain: url.hostname }],
    });
    return new Response(await screenshot.arrayBuffer(), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": noCache ? "no-store" : "public, max-age=300",
      },
    });
  },
} satisfies ExportedHandler<Env>;

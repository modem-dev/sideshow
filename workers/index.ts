import { DurableObject } from "cloudflare:workers";
import agentHowtoText from "../guide/AGENT_HOWTO.md";
import setupText from "../guide/AGENT_SETUP.md";
import guideMarkdown from "../guide/DESIGN_GUIDE.md";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "../server/app.ts";
import { SqlStore } from "../server/sqlStore.ts";
import viewerHtml from "../viewer/dist/index.html";
import { matchSurfaceScreenshot, planSurfaceScreenshot } from "./screenshot.ts";

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
    const surfaceId = matchSurfaceScreenshot(request.method, url.pathname);
    if (!surfaceId) return board.fetch(request);

    // Let the app decide auth: forward the request (with user cookies/headers)
    // to the real /s/:id?part=0 renderer. We pass theme/mode so the rendered
    // page matches what the viewer shows; the width is configurable via ?w=
    // (default 800). Social card mode is fixed at 1200x630.
    const plan = planSurfaceScreenshot(url, surfaceId, request.headers.get("cookie"));
    const checkRes = await board.fetch(new Request(plan.checkUrl, { headers: request.headers }));
    if (!checkRes.ok) return checkRes;
    // Auth passed and surface exists — discard the HTML. For HEAD, return the
    // same public image headers Slack checks without paying for Browser Rendering.
    await checkRes.arrayBuffer();
    if (request.method === "HEAD") {
      return new Response(null, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": plan.noCache ? "no-store" : "public, max-age=300",
        },
      });
    }

    const screenshot = await env.BROWSER.quickAction("screenshot", {
      url: plan.target,
      viewport: plan.viewport,
      screenshotOptions: plan.screenshotOptions,
      gotoOptions: { waitUntil: "networkidle0", timeout: 15000 },
      cacheTTL: 0,
      cookies: [{ name: "sideshow_key", value: env.SIDESHOW_TOKEN, domain: url.hostname }],
    });
    return new Response(await screenshot.arrayBuffer(), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": plan.noCache ? "no-store" : "public, max-age=300",
      },
    });
  },
} satisfies ExportedHandler<Env>;

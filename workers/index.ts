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
  SIDESHOW_TOKEN?: string;
}

// The whole app lives inside one Durable Object: a single instance per board
// means the in-memory event bus is authoritative — SSE and long-poll work
// exactly as they do locally, with SQLite-in-DO as the store.
export class SideshowBoard extends DurableObject<Env> {
  private app: ReturnType<typeof createApp>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.app = createApp({
      store: new SqlStore(ctx.storage.sql),
      viewerHtml,
      guideMarkdown,
      setupText,
      agentHowtoText,
      authToken: env.SIDESHOW_TOKEN,
      version: pkg.version,
      upgradeCommand: "git pull && npm run deploy",
    });
  }

  override fetch(request: Request) {
    return this.app.fetch(request);
  }
}

export default {
  fetch(request: Request, env: Env) {
    if (!env.SIDESHOW_TOKEN) {
      return new Response(
        "sideshow is not configured: set a token first —\n\n  wrangler secret put SIDESHOW_TOKEN\n",
        { status: 503 },
      );
    }
    const board = env.BOARD.get(env.BOARD.idFromName("default"));
    return board.fetch(request);
  },
} satisfies ExportedHandler<Env>;

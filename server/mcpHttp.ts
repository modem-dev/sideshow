import type { Hono } from "hono";
import type { CommentWait, Feedback } from "./app.ts";
import { feedbackView, mcpPostListRowView, postDetailView, postWriteView } from "./apiViews.ts";
import { decodeBase64 } from "./base64.ts";
import {
  type Asset,
  type AssetKind,
  type Comment,
  htmlSurface,
  type Store,
  type Post,
  type Surface,
} from "./types.ts";
import { HTTP_MCP_TOOLS, MCP_INSTRUCTIONS, MCP_SERVER_INFO } from "./mcpSpec.ts";
import { coerceSurfaces } from "./postSurfaces.ts";

// Stateless MCP over streamable HTTP: every request is self-contained, which
// is what a serverless deployment needs. Session continuity is explicit —
// publish_surface returns a sessionId the agent passes back on later calls.

type FlowResult<T> = Promise<
  { post: T; userFeedback?: Feedback[] } | { error: string; status: number }
>;

export interface McpDeps {
  store: Store;
  basePath?: (request: Request) => string;
  publishPost(input: {
    surfaces: Surface[];
    title?: string;
    session?: string;
    sessionTitle?: string;
    agent?: string;
  }): FlowResult<Post>;
  revisePost(id: string, patch: { surfaces?: Surface[]; title?: string }): FlowResult<Post>;
  appendPostSurface(
    id: string,
    surface: Surface,
    pos?: { before?: string; after?: string },
  ): FlowResult<Post>;
  replacePostSurface(
    id: string,
    target: string,
    replacement: { surface?: Surface; content?: string; kits?: unknown },
  ): FlowResult<Post>;
  removePostSurface(id: string, target: string): FlowResult<Post>;
  reorderPostSurfaces(id: string, order: (string | number)[]): FlowResult<Post>;
  createComment(input: {
    text: string;
    surface?: string;
    author: string;
  }): Promise<{ comment: Comment; userFeedback?: Feedback[] } | { error: string; status: number }>;
  waitForComments(q: CommentWait): Promise<{ comments: Comment[]; lastSeq: number }>;
  uploadAsset(input: {
    data: Uint8Array;
    contentType: string;
    filename?: string;
    kind?: AssetKind;
    session?: string;
  }): Promise<{ asset: Omit<Asset, "data"> } | { error: string; status: number }>;
  guide: string;
}

// Coerce loosely-typed tool args into a validated Surface[]. Unknown kinds
// and empty surfaces are dropped rather than rejected, so a slightly-off call
// still publishes what it can.
// Deprecated alias retained for older deep imports that used the legacy name.
export const coerceParts = coerceSurfaces;

export function registerMcp(app: Hono, deps: McpDeps) {
  // The view URL's path segment: legacy tools emit /s/<id>; the new post tools
  // emit the canonical /p/<id>. Both resolve to the same post page.
  const postResult = (
    result: { post: Post; userFeedback?: Feedback[] },
    origin: string,
    seg: "s" | "p" = "s",
  ) =>
    JSON.stringify(
      {
        ...postWriteView(result.post),
        url: `${origin}/${seg}/${result.post.id}`,
        ...(result.userFeedback && { userFeedback: result.userFeedback }),
      },
      null,
      2,
    );

  async function callTool(name: string, args: any, origin: string): Promise<string> {
    switch (name) {
      case "publish_post":
      case "publish_surface":
      case "publish_snippet": {
        // New tools advertise `surfaces`; legacy tools still send `parts`.
        const blocks = name === "publish_post" ? (args.surfaces ?? args.parts) : args.parts;
        const surfaces =
          name === "publish_snippet"
            ? await coerceSurfaces([htmlSurface(String(args.html ?? ""), args.kits)])
            : await coerceSurfaces(blocks);
        if (surfaces.length === 0) {
          throw new Error("a post needs at least one surface");
        }
        const result = await deps.publishPost({
          surfaces,
          title: typeof args.title === "string" ? args.title : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
          sessionTitle: typeof args.sessionTitle === "string" ? args.sessionTitle : undefined,
          agent: typeof args.agent === "string" ? args.agent : undefined,
        });
        if ("error" in result) throw new Error(result.error);
        return postResult(result, origin, name === "publish_post" ? "p" : "s");
      }
      case "update_post":
      case "update_surface":
      case "update_snippet": {
        const patch: { surfaces?: Surface[]; title?: string } = {
          title: typeof args.title === "string" ? args.title : undefined,
        };
        if (name === "update_snippet") {
          if (typeof args.html === "string")
            patch.surfaces = await coerceSurfaces([htmlSurface(args.html, args.kits)]);
        } else {
          const blocks = name === "update_post" ? (args.surfaces ?? args.parts) : args.parts;
          if (blocks !== undefined) patch.surfaces = await coerceSurfaces(blocks);
        }
        const result = await deps.revisePost(String(args.id ?? ""), patch);
        if ("error" in result) throw new Error(result.error);
        return postResult(result, origin, name === "update_post" ? "p" : "s");
      }
      case "wait_for_feedback": {
        const result = await deps.waitForComments({
          sessionId: String(args.session ?? ""),
          author: "user",
          afterSeq: typeof args.afterSeq === "number" ? args.afterSeq : undefined,
          waitSeconds: typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : 60,
        });
        if (result.comments.length === 0) {
          return JSON.stringify({
            comments: [],
            lastSeq: result.lastSeq,
            note: "no user feedback yet — continue, or wait again later",
          });
        }
        return JSON.stringify(
          {
            comments: result.comments.map(feedbackView),
            lastSeq: result.lastSeq,
          },
          null,
          2,
        );
      }
      case "reply_to_user": {
        // "user" is the reserved trust label, minted only by the viewer's
        // composer (genuine human keystrokes). The agent may name itself
        // anything else, but never the user — that would forge feedback.
        const named = typeof args.author === "string" ? args.author.trim() : "";
        const author = named && named !== "user" ? named : "agent";
        const result = await deps.createComment({
          text: String(args.message ?? ""),
          surface: String(args.postId ?? args.surfaceId ?? ""),
          author,
        });
        if ("error" in result) throw new Error(result.error);
        return JSON.stringify(
          { ...result.comment, ...(result.userFeedback && { userFeedback: result.userFeedback }) },
          null,
          2,
        );
      }
      case "list_posts":
      case "list_surfaces":
      case "list_snippets": {
        const posts = await deps.store.listPosts(
          typeof args.session === "string" ? args.session : undefined,
        );
        return JSON.stringify(posts.map(mcpPostListRowView), null, 2);
      }
      case "get_post": {
        const post = await deps.store.getPost(String(args.id ?? ""));
        if (!post) throw new Error("post not found");
        return JSON.stringify(postDetailView(post), null, 2);
      }
      case "upload_asset": {
        if (typeof args.data !== "string" || args.data.length === 0) {
          throw new Error("upload_asset needs base64 `data`");
        }
        const result = await deps.uploadAsset({
          data: decodeBase64(args.data),
          contentType: typeof args.contentType === "string" ? args.contentType : "",
          filename: typeof args.filename === "string" ? args.filename : undefined,
          kind:
            args.kind === "image" || args.kind === "trace" || args.kind === "file"
              ? args.kind
              : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
        });
        if ("error" in result) throw new Error(result.error);
        return JSON.stringify(
          {
            id: result.asset.id,
            sessionId: result.asset.sessionId,
            url: `${origin}/a/${result.asset.id}`,
            contentType: result.asset.contentType,
            byteLength: result.asset.byteLength,
            kind: result.asset.kind,
          },
          null,
          2,
        );
      }
      case "get_design_guide":
        return deps.guide;
      case "add_surface": {
        const surfaces = await coerceSurfaces([args.surface]);
        if (surfaces.length === 0) throw new Error("invalid surface");
        const result = await deps.appendPostSurface(String(args.postId ?? ""), surfaces[0], {
          before: typeof args.before === "string" ? args.before : undefined,
          after: typeof args.after === "string" ? args.after : undefined,
        });
        if ("error" in result) throw new Error(result.error);
        return postResult(result, origin, "p");
      }
      case "edit_surface": {
        let surface: Surface | undefined;
        if (args.surface !== undefined) {
          const surfaces = await coerceSurfaces([args.surface]);
          if (surfaces.length === 0) throw new Error("invalid surface");
          surface = surfaces[0];
        }
        const result = await deps.replacePostSurface(
          String(args.postId ?? ""),
          String(args.target ?? ""),
          {
            surface,
            content: typeof args.content === "string" ? args.content : undefined,
            kits: args.kits,
          },
        );
        if ("error" in result) throw new Error(result.error);
        return postResult(result, origin, "p");
      }
      case "remove_surface": {
        const result = await deps.removePostSurface(
          String(args.postId ?? ""),
          String(args.target ?? ""),
        );
        if ("error" in result) throw new Error(result.error);
        return postResult(result, origin, "p");
      }
      case "reorder_surfaces": {
        const result = await deps.reorderPostSurfaces(
          String(args.postId ?? ""),
          Array.isArray(args.order) ? args.order : [],
        );
        if ("error" in result) throw new Error(result.error);
        return postResult(result, origin, "p");
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  app.post("/mcp", async (c) => {
    const rpc = (id: unknown, result: unknown) => c.json({ jsonrpc: "2.0", id, result });
    const rpcError = (id: unknown, code: number, message: string, status = 200) =>
      c.json({ jsonrpc: "2.0", id, error: { code, message } }, status as 200);

    let msg: any;
    try {
      msg = await c.req.json();
    } catch {
      return rpcError(null, -32700, "parse error", 400);
    }
    if (Array.isArray(msg)) {
      return rpcError(null, -32600, "batch requests are not supported", 400);
    }

    if (msg.method === "initialize") {
      return rpc(msg.id, {
        protocolVersion:
          typeof msg.params?.protocolVersion === "string"
            ? msg.params.protocolVersion
            : "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: MCP_INSTRUCTIONS,
      });
    }
    if (msg.id === undefined) return c.body(null, 202); // notifications
    if (msg.method === "ping") return rpc(msg.id, {});
    if (msg.method === "tools/list") return rpc(msg.id, { tools: HTTP_MCP_TOOLS });
    if (msg.method === "tools/call") {
      const url = new URL(c.req.url);
      const baseUrl = `${url.origin}${deps.basePath?.(c.req.raw) ?? ""}`;
      try {
        const text = await callTool(msg.params?.name, msg.params?.arguments ?? {}, baseUrl);
        return rpc(msg.id, { content: [{ type: "text", text }] });
      } catch (err) {
        return rpc(msg.id, {
          content: [{ type: "text", text: `error: ${err instanceof Error ? err.message : err}` }],
          isError: true,
        });
      }
    }
    return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  });

  // Stateless server: no SSE stream to resume, no session to delete.
  app.get("/mcp", (c) => c.text("sideshow MCP is stateless — POST JSON-RPC messages here", 405));
  app.delete("/mcp", (c) => c.body(null, 405));
}

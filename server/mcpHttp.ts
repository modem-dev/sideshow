import type { Hono } from "hono";
import type { CommentWait, Feedback } from "./app.ts";
import { decodeBase64 } from "./base64.ts";
import {
  type Asset,
  type AssetKind,
  type Comment,
  htmlPart,
  type Store,
  type Surface,
  type SurfacePart,
} from "./types.ts";
import { HTTP_MCP_TOOLS, MCP_INSTRUCTIONS, MCP_SERVER_INFO } from "./mcpSpec.ts";
import { coerceSurfaceParts } from "./surfaceParts.ts";

// Stateless MCP over streamable HTTP: every request is self-contained, which
// is what a serverless deployment needs. Session continuity is explicit —
// publish_surface returns a sessionId the agent passes back on later calls.

type FlowResult<T> = Promise<
  { surface: T; userFeedback?: Feedback[] } | { error: string; status: number }
>;

export interface McpDeps {
  store: Store;
  basePath?: (request: Request) => string;
  publishSurface(input: {
    parts: SurfacePart[];
    title?: string;
    session?: string;
    sessionTitle?: string;
    agent?: string;
  }): FlowResult<Surface>;
  reviseSurface(id: string, patch: { parts?: SurfacePart[]; title?: string }): FlowResult<Surface>;
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

// Coerce loosely-typed tool args into validated SurfacePart[]. Unknown kinds
// and empty parts are dropped rather than rejected, so a slightly-off call
// still publishes what it can.
export const coerceParts = coerceSurfaceParts;

export function registerMcp(app: Hono, deps: McpDeps) {
  const surfaceResult = (result: { surface: Surface; userFeedback?: Feedback[] }, origin: string) =>
    JSON.stringify(
      {
        id: result.surface.id,
        sessionId: result.surface.sessionId,
        version: result.surface.version,
        url: `${origin}/s/${result.surface.id}`,
        ...(result.userFeedback && { userFeedback: result.userFeedback }),
      },
      null,
      2,
    );

  async function callTool(name: string, args: any, origin: string): Promise<string> {
    switch (name) {
      case "publish_surface":
      case "publish_snippet": {
        const parts =
          name === "publish_snippet"
            ? coerceParts([htmlPart(String(args.html ?? ""), args.kits)])
            : coerceParts(args.parts);
        if (parts.length === 0) throw new Error("a surface needs at least one part");
        const result = await deps.publishSurface({
          parts,
          title: typeof args.title === "string" ? args.title : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
          sessionTitle: typeof args.sessionTitle === "string" ? args.sessionTitle : undefined,
          agent: typeof args.agent === "string" ? args.agent : undefined,
        });
        if ("error" in result) throw new Error(result.error);
        return surfaceResult(result, origin);
      }
      case "update_surface":
      case "update_snippet": {
        const patch: { parts?: SurfacePart[]; title?: string } = {
          title: typeof args.title === "string" ? args.title : undefined,
        };
        if (name === "update_snippet") {
          if (typeof args.html === "string")
            patch.parts = coerceParts([htmlPart(args.html, args.kits)]);
        } else if (args.parts !== undefined) {
          patch.parts = coerceParts(args.parts);
        }
        const result = await deps.reviseSurface(String(args.id ?? ""), patch);
        if ("error" in result) throw new Error(result.error);
        return surfaceResult(result, origin);
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
            comments: result.comments.map((c) => ({
              surfaceId: c.surfaceId,
              surfaceTitle: c.surfaceTitle,
              text: c.text,
              at: c.createdAt,
            })),
            lastSeq: result.lastSeq,
          },
          null,
          2,
        );
      }
      case "reply_to_user": {
        const result = await deps.createComment({
          text: String(args.message ?? ""),
          surface: String(args.surfaceId ?? ""),
          author: typeof args.author === "string" ? args.author : "agent",
        });
        if ("error" in result) throw new Error(result.error);
        return JSON.stringify(
          { ...result.comment, ...(result.userFeedback && { userFeedback: result.userFeedback }) },
          null,
          2,
        );
      }
      case "list_surfaces":
      case "list_snippets": {
        const surfaces = await deps.store.listSurfaces(
          typeof args.session === "string" ? args.session : undefined,
        );
        return JSON.stringify(
          surfaces.map((s) => ({
            id: s.id,
            sessionId: s.sessionId,
            title: s.title,
            kinds: s.parts.map((p) => p.kind),
            version: s.version,
            updatedAt: s.updatedAt,
          })),
          null,
          2,
        );
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

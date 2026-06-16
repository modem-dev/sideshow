import type { Hono } from "hono";
import type { CommentWait, Feedback } from "./app.ts";
import { type Comment, htmlPart, type Store, type Surface, type SurfacePart } from "./types.ts";

// Stateless MCP over streamable HTTP: every request is self-contained, which
// is what a serverless deployment needs. Session continuity is explicit —
// publish_surface returns a sessionId the agent passes back on later calls.

type FlowResult<T> = Promise<
  { surface: T; userFeedback?: Feedback[] } | { error: string; status: number }
>;

export interface McpDeps {
  store: Store;
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
  guide: string;
}

// Coerce loosely-typed tool args into validated SurfacePart[]. Unknown kinds
// and empty parts are dropped rather than rejected, so a slightly-off call
// still publishes what it can.
export function coerceParts(raw: unknown): SurfacePart[] {
  if (!Array.isArray(raw)) return [];
  const parts: SurfacePart[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const kind = (p as any).kind;
    if (kind === "html" && typeof (p as any).html === "string") {
      parts.push(htmlPart((p as any).html));
    } else if (kind === "diff") {
      const patch = typeof (p as any).patch === "string" ? (p as any).patch : undefined;
      const files = Array.isArray((p as any).files)
        ? (p as any).files
            .filter((f: any) => f && typeof f.filename === "string")
            .map((f: any) => ({
              filename: String(f.filename),
              before: String(f.before ?? ""),
              after: String(f.after ?? ""),
              ...(typeof f.language === "string" && { language: f.language }),
            }))
        : undefined;
      if (!patch && (!files || files.length === 0)) continue;
      const layout = (p as any).layout === "split" ? "split" : undefined;
      parts.push({
        kind: "diff",
        ...(patch && { patch }),
        ...(files && { files }),
        ...(layout && { layout }),
      });
    }
  }
  return parts;
}

const INSTRUCTIONS =
  "sideshow is a live visual surface the user watches in a browser. Publish surfaces to illustrate concepts, " +
  "sketch UI ideas, visualize data, or show a code review while you work. A surface is an ordered list of " +
  "parts: an `html` part is markup you write (a body fragment), a `diff` part is a patch the viewer renders " +
  "as a syntax-highlighted, split/unified diff. Combine them — e.g. a diagram html part above a diff part — " +
  "in one card. publish_surface is the general tool; publish_snippet is sugar for a single html part. Call " +
  "get_design_guide once before your first publish — it defines the contract. Your first publish creates a " +
  "session and returns its sessionId: pass it as `session` on later calls so your surfaces stay grouped. On " +
  'that first publish, also pass sessionTitle to name the session after the task (e.g. "Auth refactor"). The ' +
  "user can comment in their browser; call wait_for_feedback after publishing something you want a reaction " +
  "to — it resumes where you left off. Any publish/update/reply result may also carry a userFeedback array — " +
  "comments the user left since your last call, delivered once.";

const PARTS_SCHEMA = {
  type: "array",
  description:
    "Ordered parts. An html part is {kind:'html', html:'<body fragment>'}. A diff part is normally " +
    "{kind:'diff', patch:'<unified/git diff>'} (may span multiple files) — send the patch, it is the " +
    "compact, preferred form. {kind:'diff', files:[{filename, before, after}]} also works but sends whole " +
    "file contents, so reach for it only when you lack a patch. Optional layout 'unified'|'split'. " +
    "Combine, e.g. [{kind:'html',html:'<svg.../>'},{kind:'diff',patch:'...'}].",
  items: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["html", "diff"] },
      html: { type: "string", description: "html part: body fragment (no doctype/html/head/body)" },
      patch: {
        type: "string",
        description: "diff part: a unified/git diff string — the preferred, compact form",
      },
      files: {
        type: "array",
        description:
          "diff part: explicit before/after pairs — heavier (full file contents); prefer patch",
        items: {
          type: "object",
          properties: {
            filename: { type: "string" },
            before: { type: "string" },
            after: { type: "string" },
            language: { type: "string" },
          },
          required: ["filename", "before", "after"],
        },
      },
      layout: { type: "string", enum: ["unified", "split"] },
    },
    required: ["kind"],
  },
};

const TOOLS = [
  {
    name: "publish_surface",
    description:
      "Publish a surface to the user's sideshow board. A surface is an ordered list of parts (html and/or " +
      "diff). Returns the surface id, view URL, and sessionId — pass sessionId as `session` on later calls. " +
      "On your first publish, pass sessionTitle naming the task. If the result includes userFeedback, those " +
      "are new comments from the user. Call get_design_guide first if you have not this session.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short human-readable title shown above the card" },
        parts: PARTS_SCHEMA,
        session: {
          type: "string",
          description: "Session id from a previous publish (omit on first)",
        },
        sessionTitle: {
          type: "string",
          description:
            'Session name shown in the sidebar — name the task, e.g. "Auth refactor". Honored only when ' +
            "this publish creates the session.",
        },
        agent: {
          type: "string",
          description: "Your agent name for the session label (first publish only)",
        },
      },
      required: ["title", "parts"],
    },
  },
  {
    name: "update_surface",
    description:
      "Revise a surface in place (same card, new version). Prefer this over publishing a near-duplicate. " +
      "Pass the full replacement parts array. If the result includes userFeedback, read it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Surface id returned by publish_surface" },
        parts: PARTS_SCHEMA,
        title: { type: "string", description: "Replacement title" },
      },
      required: ["id"],
    },
  },
  {
    name: "publish_snippet",
    description:
      "Publish an HTML snippet — sugar for a surface with one html part. Send a body fragment only. Returns " +
      "the id, view URL, and sessionId. Pass sessionTitle on first publish. Prefer publish_surface when you " +
      "want a diff or multiple parts.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short human-readable title" },
        html: { type: "string", description: "HTML body fragment to render" },
        session: {
          type: "string",
          description: "Session id from a previous publish (omit on first)",
        },
        sessionTitle: { type: "string", description: "Session name (first publish only)" },
        agent: { type: "string", description: "Your agent name (first publish only)" },
      },
      required: ["title", "html"],
    },
  },
  {
    name: "update_snippet",
    description: "Revise an html snippet in place — sugar for update_surface with one html part.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Surface id" },
        html: { type: "string", description: "Replacement HTML body fragment" },
        title: { type: "string", description: "Replacement title" },
      },
      required: ["id"],
    },
  },
  {
    name: "wait_for_feedback",
    description:
      "Block until the user comments on this session in their browser (or the timeout passes). Returns new " +
      "comments since the agent last received feedback on any channel. Use timeoutSeconds 0 for a " +
      "non-blocking check.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session id to watch" },
        afterSeq: {
          type: "number",
          description: "explicit cursor override (default: where the agent left off)",
        },
        timeoutSeconds: { type: "number", description: "How long to wait, 0-300 (default 60)" },
      },
      required: ["session"],
    },
  },
  {
    name: "reply_to_user",
    description:
      "Post a short reply under a surface's comment thread. Use to acknowledge feedback or explain a revision.",
    inputSchema: {
      type: "object",
      properties: {
        surfaceId: { type: "string", description: "Surface whose thread to reply in" },
        message: { type: "string", description: "Plain-text reply" },
        author: { type: "string", description: 'Your agent name (default "agent")' },
      },
      required: ["surfaceId", "message"],
    },
  },
  {
    name: "list_surfaces",
    description: "List surfaces — pass a session id to scope, or omit for all sessions.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Optional session id to scope the list" },
      },
    },
  },
  {
    name: "get_design_guide",
    description:
      "Fetch the design contract: surface parts, html fragment rules, theme CSS variables, CDN allowlist, " +
      "and the interactivity bridge. Call once per session before publishing.",
    inputSchema: { type: "object", properties: {} },
  },
];

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
            ? [htmlPart(String(args.html ?? ""))]
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
          if (typeof args.html === "string") patch.parts = [htmlPart(args.html)];
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
        serverInfo: { name: "sideshow", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    if (msg.id === undefined) return c.body(null, 202); // notifications
    if (msg.method === "ping") return rpc(msg.id, {});
    if (msg.method === "tools/list") return rpc(msg.id, { tools: TOOLS });
    if (msg.method === "tools/call") {
      const origin = new URL(c.req.url).origin;
      try {
        const text = await callTool(msg.params?.name, msg.params?.arguments ?? {}, origin);
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

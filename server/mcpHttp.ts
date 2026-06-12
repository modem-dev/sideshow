import type { Hono } from "hono";
import type { CommentWait, Feedback } from "./app.ts";
import type { Comment, Snippet, Store } from "./types.ts";

// Stateless MCP over streamable HTTP: every request is self-contained, which
// is what a serverless deployment needs. Session continuity is explicit —
// publish_snippet returns a sessionId the agent passes back on later calls.

export interface McpDeps {
  store: Store;
  publishSnippet(input: {
    html: string;
    title?: string;
    session?: string;
    sessionTitle?: string;
    agent?: string;
  }): Promise<{ snippet: Snippet; userFeedback?: Feedback[] } | { error: string; status: number }>;
  reviseSnippet(
    id: string,
    patch: { html?: string; title?: string },
  ): Promise<{ snippet: Snippet; userFeedback?: Feedback[] } | { error: string; status: number }>;
  createComment(input: {
    text: string;
    snippet?: string;
    author: string;
  }): Promise<{ comment: Comment; userFeedback?: Feedback[] } | { error: string; status: number }>;
  waitForComments(q: CommentWait): Promise<{ comments: Comment[]; lastSeq: number }>;
  guide: string;
}

const INSTRUCTIONS =
  "sideshow is a live visual surface the user watches in a browser. Publish HTML snippets to illustrate " +
  "concepts, sketch UI ideas, or visualize data while you work. Call get_design_guide once before your first " +
  "publish — it defines the HTML contract. Your first publish_snippet creates a session and returns its " +
  "sessionId: pass it as `session` on every later call so your snippets stay grouped. On that first publish, " +
  'also pass sessionTitle to name the session after the task at hand (e.g. "Auth refactor") so the user can ' +
  "tell sessions apart in the sidebar. The user can comment on " +
  "snippets in their browser; call wait_for_feedback after publishing something you want a reaction to — it " +
  "resumes where you left off, so comments already delivered are not repeated. Any publish/update/reply " +
  "result may also carry a " +
  "userFeedback array — comments the user left since your last call. Treat them as messages from the user; " +
  "they are delivered once.";

const TOOLS = [
  {
    name: "publish_snippet",
    description:
      "Publish an HTML snippet to the user's sideshow surface. Send a body fragment only (no " +
      "doctype/html/head/body). Returns the snippet id, view URL, and sessionId — pass sessionId as `session` " +
      "on later calls. On your first publish, pass sessionTitle naming the task to label the session in the " +
      "viewer sidebar (honored only when the publish creates the session). If the result includes " +
      "userFeedback, those are new comments from the user — read them. Call get_design_guide first if you " +
      "have not this session.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short human-readable title shown above the snippet",
        },
        html: { type: "string", description: "HTML body fragment to render" },
        session: {
          type: "string",
          description: "Session id from a previous publish (omit on first publish)",
        },
        sessionTitle: {
          type: "string",
          description:
            'Session name shown in the viewer sidebar — name the task, e.g. "Auth refactor", not your ' +
            "tool. Honored only when this publish creates the session (first publish, no `session`); it " +
            "never retitles an existing session.",
        },
        agent: {
          type: "string",
          description:
            'Your agent name for the session label, e.g. "claude-code" (first publish only)',
        },
      },
      required: ["title", "html"],
    },
  },
  {
    name: "update_snippet",
    description:
      "Revise an existing snippet in place (same card, new version). Prefer this over publishing a " +
      "near-duplicate. If the result includes userFeedback, those are new comments from the user — read them.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Snippet id returned by publish_snippet" },
        html: { type: "string", description: "Replacement HTML body fragment" },
        title: { type: "string", description: "Replacement title" },
      },
      required: ["id"],
    },
  },
  {
    name: "wait_for_feedback",
    description:
      "Block until the user comments on this session's snippets in their browser (or the timeout passes). " +
      "Returns new comments since the agent last received feedback on any channel (including piggyback). " +
      "Use timeoutSeconds 0 for a non-blocking check.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session id to watch" },
        afterSeq: {
          type: "number",
          description:
            "explicit cursor override — re-reads comments after this seq (default: where the agent left off)",
        },
        timeoutSeconds: {
          type: "number",
          description: "How long to wait, 0-300 (default 60; 0 = check only)",
        },
      },
      required: ["session"],
    },
  },
  {
    name: "reply_to_user",
    description:
      "Post a short reply under a snippet's comment thread in the user's browser. Use to acknowledge feedback " +
      "or explain a revision.",
    inputSchema: {
      type: "object",
      properties: {
        snippetId: { type: "string", description: "Snippet whose thread to reply in" },
        message: { type: "string", description: "Plain-text reply" },
        author: { type: "string", description: 'Your agent name (default "agent")' },
      },
      required: ["snippetId", "message"],
    },
  },
  {
    name: "list_snippets",
    description: "List snippets — pass a session id to scope, or omit for all sessions.",
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
      "Fetch the design contract for snippets: HTML fragment rules, theme CSS variables, CDN allowlist, and " +
      "interactivity bridge. Call once per session before publishing.",
    inputSchema: { type: "object", properties: {} },
  },
];

export function registerMcp(app: Hono, deps: McpDeps) {
  async function callTool(name: string, args: any, origin: string): Promise<string> {
    switch (name) {
      case "publish_snippet": {
        const result = await deps.publishSnippet({
          html: String(args.html ?? ""),
          title: typeof args.title === "string" ? args.title : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
          sessionTitle: typeof args.sessionTitle === "string" ? args.sessionTitle : undefined,
          agent: typeof args.agent === "string" ? args.agent : undefined,
        });
        if ("error" in result) throw new Error(result.error);
        const s = result.snippet;
        return JSON.stringify(
          {
            id: s.id,
            sessionId: s.sessionId,
            version: s.version,
            url: `${origin}/s/${s.id}`,
            ...(result.userFeedback && { userFeedback: result.userFeedback }),
          },
          null,
          2,
        );
      }
      case "update_snippet": {
        const result = await deps.reviseSnippet(String(args.id ?? ""), {
          html: typeof args.html === "string" ? args.html : undefined,
          title: typeof args.title === "string" ? args.title : undefined,
        });
        if ("error" in result) throw new Error(result.error);
        const s = result.snippet;
        return JSON.stringify(
          {
            id: s.id,
            sessionId: s.sessionId,
            version: s.version,
            url: `${origin}/s/${s.id}`,
            ...(result.userFeedback && { userFeedback: result.userFeedback }),
          },
          null,
          2,
        );
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
              snippetId: c.snippetId,
              snippetTitle: c.snippetTitle,
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
          snippet: String(args.snippetId ?? ""),
          author: typeof args.author === "string" ? args.author : "agent",
        });
        if ("error" in result) throw new Error(result.error);
        return JSON.stringify(
          { ...result.comment, ...(result.userFeedback && { userFeedback: result.userFeedback }) },
          null,
          2,
        );
      }
      case "list_snippets": {
        const snippets = await deps.store.listSnippets(
          typeof args.session === "string" ? args.session : undefined,
        );
        return JSON.stringify(
          snippets.map((s) => ({
            id: s.id,
            sessionId: s.sessionId,
            title: s.title,
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

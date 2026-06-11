#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Point at a deployed instance later by setting SIDESHOW_URL.
const API = process.env.SIDESHOW_URL ?? "http://localhost:4242";
const TOKEN = process.env.SIDESHOW_TOKEN;
const AGENT = process.env.SIDESHOW_AGENT ?? "claude-code";

async function api(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...init, headers });
  } catch {
    throw new Error(
      `sideshow server not reachable at ${API} — ask the user to start it with "sideshow serve" or "npm run dev"`,
    );
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text;
}

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

// One MCP server process lives as long as one agent conversation, so a
// lazily-created session shared across tool calls maps cleanly onto it.
let sessionId: string | null = process.env.SIDESHOW_SESSION ?? null;
let lastSeq = 0;

async function ensureSession(): Promise<string> {
  if (sessionId) return sessionId;
  const session = JSON.parse(
    await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ agent: AGENT, cwd: process.cwd() }),
    }),
  );
  sessionId = session.id as string;
  return sessionId;
}

const server = new McpServer(
  { name: "sideshow", version: "0.1.0" },
  {
    instructions:
      "sideshow is a live visual surface the user watches in a browser. Publish HTML snippets to illustrate " +
      "concepts, sketch UI ideas, or visualize data while you work. Call get_design_guide once before your first " +
      "publish — it defines the HTML contract. Your snippets are grouped into one session for this conversation. " +
      "The user can comment on snippets in their browser; check with wait_for_feedback after publishing something " +
      "you want a reaction to. Any publish/update/reply result may also carry a userFeedback array — comments " +
      "the user left since your last call. Treat them as messages from the user; they are delivered once.",
  },
);

server.registerTool(
  "publish_snippet",
  {
    description:
      "Publish an HTML snippet to the user's sideshow surface. Send a body fragment only (no " +
      "doctype/html/head/body). Returns the snippet id and view URL. If the result includes userFeedback, " +
      "those are new comments from the user — read them. Call get_design_guide first if you have not this " +
      "session.",
    inputSchema: {
      title: z.string().describe("Short human-readable title shown above the snippet"),
      html: z.string().describe("HTML body fragment to render"),
    },
  },
  async ({ title, html }) => {
    const session = await ensureSession();
    const created = JSON.parse(
      await api("/api/snippets", {
        method: "POST",
        body: JSON.stringify({ title, html, session }),
      }),
    );
    return text({ ...created, url: `${API}/s/${created.id}` });
  },
);

server.registerTool(
  "update_snippet",
  {
    description:
      "Revise an existing snippet in place (same card, new version). Prefer this over publishing a " +
      "near-duplicate. If the result includes userFeedback, those are new comments from the user — read them.",
    inputSchema: {
      id: z.string().describe("Snippet id returned by publish_snippet"),
      html: z.string().optional().describe("Replacement HTML body fragment"),
      title: z.string().optional().describe("Replacement title"),
    },
  },
  async ({ id, html, title }) => {
    const updated = JSON.parse(
      await api(`/api/snippets/${id}`, { method: "PUT", body: JSON.stringify({ html, title }) }),
    );
    return text({ ...updated, url: `${API}/s/${updated.id}` });
  },
);

server.registerTool(
  "wait_for_feedback",
  {
    description:
      "Block until the user comments on this session's snippets in their browser (or the timeout passes). " +
      "Returns new comments since the last call. Use after publishing something that needs the user's reaction; " +
      "use timeoutSeconds=0 for a non-blocking check.",
    inputSchema: {
      timeoutSeconds: z
        .number()
        .min(0)
        .max(300)
        .optional()
        .describe("How long to wait (default 120, 0 = check only)"),
    },
  },
  async ({ timeoutSeconds }) => {
    const session = await ensureSession();
    const wait = timeoutSeconds ?? 120;
    const result = JSON.parse(
      await api(`/api/comments?session=${session}&author=user&after=${lastSeq}&wait=${wait}`),
    );
    lastSeq = result.lastSeq;
    if (result.comments.length === 0) {
      return text({ comments: [], note: "no user feedback yet — continue, or wait again later" });
    }
    return text({
      comments: result.comments.map((c: any) => ({
        snippetId: c.snippetId,
        snippetTitle: c.snippetTitle,
        text: c.text,
        at: c.createdAt,
      })),
    });
  },
);

server.registerTool(
  "reply_to_user",
  {
    description:
      "Post a short reply under a snippet's comment thread in the user's browser. Use to acknowledge feedback " +
      "or explain a revision without making the user switch to the terminal.",
    inputSchema: {
      snippetId: z.string().describe("Snippet whose thread to reply in"),
      message: z.string().describe("Plain-text reply"),
    },
  },
  async ({ snippetId, message }) => {
    const created = JSON.parse(
      await api("/api/comments", {
        method: "POST",
        body: JSON.stringify({ snippet: snippetId, text: message, author: AGENT }),
      }),
    );
    return text(created);
  },
);

server.registerTool(
  "list_snippets",
  { description: "List snippets in this conversation's session.", inputSchema: {} },
  async () => {
    if (!sessionId) return text([]);
    return text(JSON.parse(await api(`/api/sessions/${sessionId}/snippets`)));
  },
);

server.registerTool(
  "get_design_guide",
  {
    description:
      "Fetch the design contract for snippets: HTML fragment rules, theme CSS variables, CDN allowlist, and " +
      "interactivity bridge. Call once per session before publishing.",
    inputSchema: {},
  },
  async () => text(await api("/guide")),
);

await server.connect(new StdioServerTransport());

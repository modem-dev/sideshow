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

// `title` is used only when this call creates the session — once one exists
// (here or in the viewer, where the user can rename it) it is never retitled.
async function ensureSession(title?: string): Promise<string> {
  if (sessionId) return sessionId;
  const session = JSON.parse(
    await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ agent: AGENT, cwd: process.cwd(), title }),
    }),
  );
  sessionId = session.id as string;
  return sessionId;
}

const diffFileSchema = z.object({
  filename: z.string(),
  before: z.string(),
  after: z.string(),
  language: z.string().optional(),
});

const partSchema = z
  .object({
    kind: z.enum(["html", "diff"]),
    html: z.string().optional().describe("html part: body fragment (no doctype/html/head/body)"),
    patch: z
      .string()
      .optional()
      .describe("diff part: a unified/git diff string (preferred, compact)"),
    files: z
      .array(diffFileSchema)
      .optional()
      .describe("diff part: before/after pairs — heavier (full contents); prefer patch"),
    layout: z.enum(["unified", "split"]).optional(),
  })
  .describe(
    "A surface part: {kind:'html', html} or {kind:'diff', patch} (preferred) / {kind:'diff', files}",
  );

const server = new McpServer(
  { name: "sideshow", version: "0.1.0" },
  {
    instructions:
      "sideshow is a live visual surface the user watches in a browser. Publish surfaces to illustrate " +
      "concepts, sketch UI ideas, visualize data, or show a code review while you work. A surface is an " +
      "ordered list of parts: an `html` part is markup you write, a `diff` part is a patch the viewer renders " +
      "as a syntax-highlighted split/unified diff. Combine them in one card. publish_surface is the general " +
      "tool; publish_snippet is sugar for a single html part. Call get_design_guide once before your first " +
      "publish. Your surfaces are grouped into one session for this conversation; on your first publish pass " +
      'sessionTitle to name the session after the task (e.g. "Auth refactor"). The user can comment in their ' +
      "browser; check with wait_for_feedback after publishing something you want a reaction to. Any " +
      "publish/update/reply result may carry a userFeedback array — comments the user left since your last " +
      "call, delivered once.",
  },
);

server.registerTool(
  "publish_surface",
  {
    description:
      "Publish a surface (an ordered list of html and/or diff parts) to the user's sideshow board. Returns " +
      "the id and view URL. On your first publish, pass sessionTitle naming the task. If the result includes " +
      "userFeedback, read it. Call get_design_guide first if you have not this session.",
    inputSchema: {
      title: z.string().describe("Short human-readable title shown above the card"),
      parts: z.array(partSchema).describe("Ordered parts; combine html and diff freely"),
      sessionTitle: z
        .string()
        .optional()
        .describe('Session name (first publish only), e.g. "Auth refactor"'),
    },
  },
  async ({ title, parts, sessionTitle }) => {
    const session = await ensureSession(sessionTitle);
    const created = JSON.parse(
      await api("/api/surfaces", {
        method: "POST",
        body: JSON.stringify({ title, parts, session }),
      }),
    );
    return text({ ...created, url: `${API}/s/${created.id}` });
  },
);

server.registerTool(
  "update_surface",
  {
    description:
      "Revise a surface in place (same card, new version). Prefer this over a near-duplicate. Pass the full " +
      "replacement parts array. If the result includes userFeedback, read it.",
    inputSchema: {
      id: z.string().describe("Surface id returned by publish_surface"),
      parts: z.array(partSchema).optional().describe("Replacement parts array"),
      title: z.string().optional().describe("Replacement title"),
    },
  },
  async ({ id, parts, title }) => {
    const updated = JSON.parse(
      await api(`/api/surfaces/${id}`, { method: "PUT", body: JSON.stringify({ parts, title }) }),
    );
    return text({ ...updated, url: `${API}/s/${updated.id}` });
  },
);

server.registerTool(
  "publish_snippet",
  {
    description:
      "Publish an HTML snippet — sugar for a surface with one html part. Send a body fragment only. Returns " +
      "the id and view URL. Prefer publish_surface when you want a diff or multiple parts.",
    inputSchema: {
      title: z.string().describe("Short human-readable title shown above the snippet"),
      html: z.string().describe("HTML body fragment to render"),
      sessionTitle: z.string().optional().describe("Session name (first publish only)"),
    },
  },
  async ({ title, html, sessionTitle }) => {
    const session = await ensureSession(sessionTitle);
    const created = JSON.parse(
      await api("/api/surfaces", {
        method: "POST",
        body: JSON.stringify({ title, parts: [{ kind: "html", html }], session }),
      }),
    );
    return text({ ...created, url: `${API}/s/${created.id}` });
  },
);

server.registerTool(
  "update_snippet",
  {
    description: "Revise an html snippet in place — sugar for update_surface with one html part.",
    inputSchema: {
      id: z.string().describe("Surface id"),
      html: z.string().optional().describe("Replacement HTML body fragment"),
      title: z.string().optional().describe("Replacement title"),
    },
  },
  async ({ id, html, title }) => {
    const parts = html === undefined ? undefined : [{ kind: "html", html }];
    const updated = JSON.parse(
      await api(`/api/surfaces/${id}`, { method: "PUT", body: JSON.stringify({ parts, title }) }),
    );
    return text({ ...updated, url: `${API}/s/${updated.id}` });
  },
);

server.registerTool(
  "wait_for_feedback",
  {
    description:
      "Block until the user comments on this session in their browser (or the timeout passes). Returns new " +
      "comments since the last call. Use timeoutSeconds=0 for a non-blocking check.",
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
    // No client-side cursor: the server resumes author=user reads from the
    // session's agent cursor, shared with piggyback delivery.
    const result = JSON.parse(
      await api(`/api/comments?session=${session}&author=user&wait=${wait}`),
    );
    if (result.comments.length === 0) {
      return text({ comments: [], note: "no user feedback yet — continue, or wait again later" });
    }
    return text({
      comments: result.comments.map((c: any) => ({
        surfaceId: c.surfaceId,
        surfaceTitle: c.surfaceTitle,
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
      "Post a short reply under a surface's comment thread in the user's browser. Use to acknowledge feedback " +
      "or explain a revision without making the user switch to the terminal.",
    inputSchema: {
      surfaceId: z.string().describe("Surface whose thread to reply in"),
      message: z.string().describe("Plain-text reply"),
    },
  },
  async ({ surfaceId, message }) => {
    const created = JSON.parse(
      await api("/api/comments", {
        method: "POST",
        body: JSON.stringify({ surface: surfaceId, text: message, author: AGENT }),
      }),
    );
    return text(created);
  },
);

server.registerTool(
  "list_surfaces",
  { description: "List surfaces in this conversation's session.", inputSchema: {} },
  async () => {
    if (!sessionId) return text([]);
    return text(JSON.parse(await api(`/api/sessions/${sessionId}/surfaces`)));
  },
);

server.registerTool(
  "get_design_guide",
  {
    description:
      "Fetch the design contract: surface parts, html fragment rules, theme CSS variables, CDN allowlist, and " +
      "the interactivity bridge. Call once per session before publishing.",
    inputSchema: {},
  },
  async () => text(await api("/guide")),
);

await server.connect(new StdioServerTransport());

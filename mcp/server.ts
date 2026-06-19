#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_INFO,
  MCP_TOOL_DESCRIPTIONS,
  STDIO_MCP_INPUT_SCHEMAS,
} from "../server/mcpSpec.ts";

// Point at a deployed instance later by setting SIDESHOW_URL.
const API = process.env.SIDESHOW_URL ?? "http://localhost:8228";
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

const server = new McpServer(MCP_SERVER_INFO, { instructions: MCP_INSTRUCTIONS });

server.registerTool(
  "publish_surface",
  {
    description: MCP_TOOL_DESCRIPTIONS.publishSurfaceStdio,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.publishSurface,
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
    description: MCP_TOOL_DESCRIPTIONS.updateSurface,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.updateSurface,
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
    description: MCP_TOOL_DESCRIPTIONS.publishSnippet,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.publishSnippet,
  },
  async ({ title, html, kits, sessionTitle }) => {
    const session = await ensureSession(sessionTitle);
    const created = JSON.parse(
      await api("/api/surfaces", {
        method: "POST",
        body: JSON.stringify({ title, parts: [{ kind: "html", html, kits }], session }),
      }),
    );
    return text({ ...created, url: `${API}/s/${created.id}` });
  },
);

server.registerTool(
  "update_snippet",
  {
    description: MCP_TOOL_DESCRIPTIONS.updateSnippet,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.updateSnippet,
  },
  async ({ id, html, title, kits }) => {
    const parts = html === undefined ? undefined : [{ kind: "html", html, kits }];
    const updated = JSON.parse(
      await api(`/api/surfaces/${id}`, { method: "PUT", body: JSON.stringify({ parts, title }) }),
    );
    return text({ ...updated, url: `${API}/s/${updated.id}` });
  },
);

server.registerTool(
  "wait_for_feedback",
  {
    description: MCP_TOOL_DESCRIPTIONS.waitForFeedback,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.waitForFeedback,
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
    description: MCP_TOOL_DESCRIPTIONS.replyToUser,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.replyToUser,
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
  { description: MCP_TOOL_DESCRIPTIONS.listSurfacesStdio, inputSchema: {} },
  async () => {
    if (!sessionId) return text([]);
    return text(JSON.parse(await api(`/api/sessions/${sessionId}/surfaces`)));
  },
);

server.registerTool(
  "upload_asset",
  {
    description: MCP_TOOL_DESCRIPTIONS.uploadAssetStdio,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.uploadAsset,
  },
  async ({ data, contentType, filename, kind }) => {
    const session = await ensureSession();
    const created = JSON.parse(
      await api("/api/assets", {
        method: "POST",
        body: JSON.stringify({ data, contentType, filename, kind, session }),
      }),
    );
    return text(created);
  },
);

server.registerTool(
  "get_design_guide",
  {
    description: MCP_TOOL_DESCRIPTIONS.getDesignGuide,
    inputSchema: {},
  },
  async () => text(await api("/guide")),
);

await server.connect(new StdioServerTransport());

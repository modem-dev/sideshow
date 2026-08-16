#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { feedbackView, mcpPostListRowView } from "../server/apiViews.ts";
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
  "publish_post",
  {
    description: MCP_TOOL_DESCRIPTIONS.publishPostStdio,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.publishPost,
  },
  async ({ title, surfaces, sessionTitle }) => {
    const session = await ensureSession(sessionTitle);
    const created = JSON.parse(
      await api("/api/posts", {
        method: "POST",
        body: JSON.stringify({ title, surfaces, session }),
      }),
    );
    return text({ ...created, url: `${API}/p/${created.id}` });
  },
);

server.registerTool(
  "update_post",
  {
    description: MCP_TOOL_DESCRIPTIONS.updatePost,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.updatePost,
  },
  async ({ id, surfaces, title }) => {
    const updated = JSON.parse(
      await api(`/api/posts/${id}`, { method: "PUT", body: JSON.stringify({ surfaces, title }) }),
    );
    return text({ ...updated, url: `${API}/p/${updated.id}` });
  },
);

server.registerTool(
  "list_posts",
  { description: MCP_TOOL_DESCRIPTIONS.listPostsStdio, inputSchema: {} },
  async () => {
    if (!sessionId) return text([]);
    const rows = JSON.parse(await api(`/api/sessions/${sessionId}/posts`));
    return text(rows.map(mcpPostListRowView));
  },
);

server.registerTool(
  "get_post",
  {
    description: MCP_TOOL_DESCRIPTIONS.getPost,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.getPost,
  },
  async ({ id }) => {
    return text(JSON.parse(await api(`/api/posts/${id}`)));
  },
);

server.registerTool(
  "publish_surface",
  {
    description: MCP_TOOL_DESCRIPTIONS.publishSurfaceStdio,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.publishSurface,
  },
  async ({ title, parts, sessionTitle }) => {
    const session = await ensureSession(sessionTitle);
    const created = JSON.parse(
      await api("/api/posts", {
        method: "POST",
        body: JSON.stringify({ title, surfaces: parts, session }),
      }),
    );
    return text({ ...created, url: `${API}/p/${created.id}` });
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
      await api(`/api/posts/${id}`, {
        method: "PUT",
        body: JSON.stringify({ surfaces: parts, title }),
      }),
    );
    return text({ ...updated, url: `${API}/p/${updated.id}` });
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
      await api("/api/posts", {
        method: "POST",
        body: JSON.stringify({ title, surfaces: [{ kind: "html", html, kits }], session }),
      }),
    );
    return text({ ...created, url: `${API}/p/${created.id}` });
  },
);

server.registerTool(
  "update_snippet",
  {
    description: MCP_TOOL_DESCRIPTIONS.updateSnippet,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.updateSnippet,
  },
  async ({ id, html, title, kits }) => {
    const surfaces = html === undefined ? undefined : [{ kind: "html", html, kits }];
    const updated = JSON.parse(
      await api(`/api/posts/${id}`, { method: "PUT", body: JSON.stringify({ surfaces, title }) }),
    );
    return text({ ...updated, url: `${API}/p/${updated.id}` });
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
      comments: result.comments.map(feedbackView),
    });
  },
);

server.registerTool(
  "reply_to_user",
  {
    description: MCP_TOOL_DESCRIPTIONS.replyToUser,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.replyToUser,
  },
  async ({ postId, surfaceId, message }) => {
    const created = JSON.parse(
      await api("/api/comments", {
        method: "POST",
        body: JSON.stringify({ surface: postId ?? surfaceId, text: message }),
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
    const rows = JSON.parse(await api(`/api/sessions/${sessionId}/surfaces`));
    return text(rows.map(mcpPostListRowView));
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

server.registerTool(
  "send_test_post",
  {
    description: MCP_TOOL_DESCRIPTIONS.sendTestPost,
    inputSchema: {},
  },
  async () => {
    // The server owns the fixed content and the already-sent check; this tool
    // is just the trigger. The welcome card lives in its own "Getting started"
    // session, so the conversation's lazy session is deliberately not used.
    const created = JSON.parse(
      await api("/api/test-post", { method: "POST", body: JSON.stringify({ agent: AGENT }) }),
    );
    return text({ ...created, url: `${API}/p/${created.id}` });
  },
);

server.registerTool(
  "add_surface",
  {
    description: MCP_TOOL_DESCRIPTIONS.addSurface,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.addSurface,
  },
  async ({ postId, surface, before, after }) => {
    const updated = JSON.parse(
      await api(`/api/posts/${postId}/surfaces`, {
        method: "POST",
        body: JSON.stringify({ surface, before, after }),
      }),
    );
    return text({ ...updated, url: `${API}/p/${updated.id}` });
  },
);

server.registerTool(
  "edit_surface",
  {
    description: MCP_TOOL_DESCRIPTIONS.editSurface,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.editSurface,
  },
  async ({ postId, target, surface, content, kits }) => {
    const updated = JSON.parse(
      await api(`/api/posts/${postId}/surfaces/${target}`, {
        method: "PATCH",
        body: JSON.stringify({ surface, content, kits }),
      }),
    );
    return text({ ...updated, url: `${API}/p/${updated.id}` });
  },
);

server.registerTool(
  "remove_surface",
  {
    description: MCP_TOOL_DESCRIPTIONS.removeSurface,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.removeSurface,
  },
  async ({ postId, target }) => {
    const updated = JSON.parse(
      await api(`/api/posts/${postId}/surfaces/${target}`, { method: "DELETE" }),
    );
    return text({ ...updated, url: `${API}/p/${updated.id}` });
  },
);

server.registerTool(
  "reorder_surfaces",
  {
    description: MCP_TOOL_DESCRIPTIONS.reorderSurfaces,
    inputSchema: STDIO_MCP_INPUT_SCHEMAS.reorderSurfaces,
  },
  async ({ postId, order }) => {
    const updated = JSON.parse(
      await api(`/api/posts/${postId}/surfaces`, {
        method: "PATCH",
        body: JSON.stringify({ order }),
      }),
    );
    return text({ ...updated, url: `${API}/p/${updated.id}` });
  },
);

await server.connect(new StdioServerTransport());

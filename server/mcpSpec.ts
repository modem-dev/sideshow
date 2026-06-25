import { z } from "zod";
import { KIT_IDS } from "./kits.ts";
import { SURFACE_KINDS, type SurfaceKind } from "./types.ts";

export const MCP_SERVER_INFO = { name: "sideshow", version: "0.1.0" };

// The `kind` enum both MCP transports advertise — derived from the one canonical
// list (types.ts) so the MCP tier can never again fall behind what REST/CLI
// accept. Non-empty tuple cast so z.enum keeps the literal union.
const PART_KIND_ENUM = [...SURFACE_KINDS] as [SurfaceKind, ...SurfaceKind[]];

export const MCP_INSTRUCTIONS =
  "sideshow is a live visual surface the user watches in a browser. Publish posts to illustrate " +
  "concepts, sketch UI ideas, visualize data, or show a code review while you work. A post is an " +
  "ordered list of surfaces: an `html` surface is markup you write (a body fragment), a `markdown` surface is " +
  "prose the viewer renders with consistent typography, a `mermaid` surface is diagram source the viewer " +
  "renders to an SVG (flowchart, sequence, ERD, …), a `diff` surface is a patch the viewer renders as " +
  "a syntax-highlighted split/unified diff, a `json` surface is any JSON value rendered as a collapsible " +
  "tree, and a `code` surface is source the viewer syntax-highlights. Combine them — e.g. a markdown rationale above a diff surface — " +
  "in one card. publish_post is the general tool; publish_snippet is " +
  "sugar for a single html surface. Call get_design_guide once before your first publish. On your first " +
  'publish, also pass sessionTitle to name the session after the task (e.g. "Auth refactor"). The ' +
  "user can comment in their browser; call wait_for_feedback after publishing something you want a " +
  "reaction to. Any publish/update/reply result may carry a userFeedback array — comments the user " +
  "left since your last call, delivered once.";

const d = {
  title: "Short human-readable title shown above the card",
  html: "HTML body fragment to render",
  session: "Session id from a previous publish (omit on first)",
  sessionTitle:
    'Session name shown in the sidebar — name the task, e.g. "Auth refactor". Honored only when this publish creates the session.',
  stdioSessionTitle: 'Session name (first publish only), e.g. "Auth refactor"',
  agent: "Your agent name for the session label (first publish only)",
  surfaceId: "Post id returned by a publish call",
  replacementTitle: "Replacement title",
  replacementParts: "Replacement surfaces array",
  timeout: "How long to wait, 0-300",
  afterSeq: "explicit cursor override (default: where the agent left off)",
  replyMessage: "Plain-text reply",
  assetData: "base64-encoded file bytes",
  assetContentType: "MIME type, e.g. image/png, application/json",
  assetFilename: "Original filename (used for downloads)",
  assetKind: "Asset kind (inferred from contentType when omitted)",
  assetSession: "Session id to attach the asset to",
  surfaceHtml: "html surface: body fragment (no doctype/html/head/body)",
  surfaceKits: `html surface: opt into style/behavior bundles by id (${KIT_IDS.join(
    " | ",
  )}). Each injects extra CSS/JS classes (e.g. 'issues' gives .card/.tree/.badge; 'slides' gives a stepped .deck). Omit for plain html. See get_design_guide.`,
  surfaceMarkdown:
    "markdown surface: prose (headings, lists, tables, code, links); raw HTML is escaped",
  surfaceMermaid:
    "mermaid surface: diagram source (flowchart, sequence, ERD, gantt, …), rendered to SVG by the viewer",
  surfacePatch: "diff surface: a unified/git diff string — the preferred, compact form",
  surfaceFiles: "diff surface: before/after pairs — heavier (full contents); prefer patch",
  surfaceAssetId: "image/trace surface: id returned by upload_asset",
  imageAlt: "image surface: alt text",
  imageCaption: "image surface: caption shown under the image",
  traceTitle: "trace surface: heading above the timeline",
  traceSteps: "trace surface: ordered steps rendered as a timeline",
  traceLabel: "one-line summary of the step",
  traceKind: "free tag, e.g. tool|thought|shell",
  traceDetail: "expandable body (output, args, reasoning)",
  traceTs: "ISO timestamp",
  terminalText: "terminal surface: raw output (ANSI SGR color escapes are rendered)",
  terminalCols: "terminal surface: optional render width in columns",
  surfaceData:
    "json surface: any JSON value (object, array, string, number, boolean, null) — the viewer renders it as a collapsible tree",
  surfaceCode: "code surface: source code the viewer syntax-highlights and shows with line numbers",
  surfaceLanguage:
    "code surface: language id (ts, js, python, go, rust, …); omit or use 'text' for plain monospace",
  surfaceLineStart:
    "code surface: 1-based starting line number for an excerpt (the viewer numbers from here instead of 1)",
};

const MCP_SURFACES_DESCRIPTION =
  "Ordered surfaces. html: {kind:'html', html:'<body fragment>', kits?:['issues']} — kits opt the " +
  "surface into extra CSS/JS bundles (issues: .card/.tree/.badge/.bar; slides: a stepped .deck with " +
  "controls); omit for plain html. markdown: {kind:'markdown', " +
  "markdown:'## prose'} — for explanations, plans, tradeoff write-ups (styled text, not sandboxed; " +
  "embedded raw HTML is escaped — use an html surface for live markup). mermaid: {kind:'mermaid', " +
  "mermaid:'graph TD; A-->B'} — diagram source rendered to SVG (flowchart, sequence, ERD, gantt, …). " +
  "diff: {kind:'diff', " +
  "patch:'<unified/git diff>'} (preferred, compact) or {kind:'diff', files:[{filename, before, " +
  "after}]} (heavier). image: {kind:'image', assetId:'<from upload_asset>', alt?, caption?} — " +
  "renders an uploaded image; you can also embed the asset URL in an html surface instead. trace: " +
  "{kind:'trace', steps:[{label, kind?, detail?, ts?}]} renders a step timeline, and/or " +
  "{kind:'trace', assetId} for an uploaded trace file (downloadable). terminal: {kind:'terminal', " +
  "text:'<output>', cols?, title?} renders monospace terminal output (ANSI SGR colors supported; " +
  "cursor-addressing TUIs are not resolved). json: {kind:'json', data:<any JSON value>} renders a " +
  "collapsible tree. code: {kind:'code', code:'<source>', language?, title?, lineStart?} renders " +
  "syntax-highlighted source with line numbers. Optional diff layout " +
  "'unified'|'split'. Combine freely, e.g. [{kind:'html',...},{kind:'image',assetId},{kind:'trace',steps}].";

const MCP_SURFACE_JSON_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: PART_KIND_ENUM,
    },
    html: { type: "string", description: d.surfaceHtml },
    kits: { type: "array", items: { type: "string" }, description: d.surfaceKits },
    markdown: { type: "string", description: d.surfaceMarkdown },
    mermaid: { type: "string", description: d.surfaceMermaid },
    patch: { type: "string", description: d.surfacePatch },
    files: {
      type: "array",
      description: d.surfaceFiles,
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
    assetId: { type: "string", description: d.surfaceAssetId },
    alt: { type: "string", description: d.imageAlt },
    caption: { type: "string", description: d.imageCaption },
    title: { type: "string", description: d.traceTitle },
    text: { type: "string", description: d.terminalText },
    cols: { type: "number", description: d.terminalCols },
    data: { description: d.surfaceData },
    code: { type: "string", description: d.surfaceCode },
    language: { type: "string", description: d.surfaceLanguage },
    lineStart: { type: "number", description: d.surfaceLineStart },
    steps: {
      type: "array",
      description: d.traceSteps,
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: d.traceLabel },
          kind: { type: "string", description: d.traceKind },
          detail: { type: "string", description: d.traceDetail },
          ts: { type: "string", description: d.traceTs },
        },
        required: ["label"],
      },
    },
  },
  required: ["kind"],
} as const;

const MCP_SURFACES_JSON_SCHEMA = {
  type: "array",
  description: MCP_SURFACES_DESCRIPTION,
  items: MCP_SURFACE_JSON_SCHEMA,
} as const;

export const MCP_TOOL_DESCRIPTIONS = {
  publishPostHttp:
    "Publish a post to the user's sideshow workspace. A post is an ordered list of surfaces (html, markdown, mermaid, diff, image, trace, terminal, json, code). Returns the post id, view URL, and sessionId — pass sessionId as `session` on later calls. On your first publish, pass sessionTitle naming the task. If the result includes userFeedback, those are new comments from the user. Call get_design_guide first if you have not this session.",
  publishPostStdio:
    "Publish a post to the user's sideshow workspace. A post is an ordered list of surfaces (html, markdown, mermaid, diff, image, trace, terminal, json, code). Returns the post id and view URL. On your first publish, pass sessionTitle naming the task. If the result includes userFeedback, those are new comments from the user. Call get_design_guide first if you have not this session.",
  updatePost:
    "Revise a post in place (same card, new version). Prefer this over publishing a near-duplicate. Pass the full replacement surfaces array. If the result includes userFeedback, read it.",
  listPostsHttp: "List posts — pass a session id to scope, or omit for all sessions.",
  listPostsStdio: "List posts in this conversation's session.",
  publishSurfaceHttp:
    "Deprecated alias of publish_post — Publish a post to the user's sideshow workspace. A post is an ordered list of surfaces (html, markdown, mermaid, diff, image, trace, terminal, json, code). Returns the post id, view URL, and sessionId — pass sessionId as `session` on later calls. On your first publish, pass sessionTitle naming the task. If the result includes userFeedback, those are new comments from the user. Call get_design_guide first if you have not this session.",
  publishSurfaceStdio:
    "Deprecated alias of publish_post — Publish a post to the user's sideshow workspace. A post is an ordered list of surfaces (html, markdown, mermaid, diff, image, trace, terminal, json, code). Returns the post id and view URL. On your first publish, pass sessionTitle naming the task. If the result includes userFeedback, those are new comments from the user. Call get_design_guide first if you have not this session.",
  updateSurface:
    "Deprecated alias of update_post — Revise a post in place (same card, new version). Prefer this over publishing a near-duplicate. Pass the full replacement surfaces array. If the result includes userFeedback, read it.",
  publishSnippet:
    "Publish an HTML snippet — sugar for a post with one html surface. Send a body fragment only. Returns the id, view URL, and sessionId. Pass sessionTitle on first publish. Prefer publish_post when you want a diff or multiple surfaces.",
  updateSnippet: "Revise an html snippet in place — sugar for update_post with one html surface.",
  waitForFeedback:
    "Block until the user comments on this session in their browser (or the timeout passes). Returns new comments since the agent last received feedback on any channel. Use timeoutSeconds 0 for a non-blocking check.",
  replyToUser:
    "Post a short reply under a post's comment thread. Use to acknowledge feedback or explain a revision.",
  listSurfacesHttp:
    "Deprecated alias of list_posts — List posts; pass a session id to scope, or omit for all sessions.",
  listSurfacesStdio: "Deprecated alias of list_posts — List posts in this conversation's session.",
  uploadAsset:
    "Upload a binary asset (image, trace file, any file) and get back its id and URL. base64-encode the bytes in `data` (MCP carries no binary). Then reference it: put {kind:'image', assetId} or {kind:'trace', assetId} in a post's surfaces, or embed the returned url in an html surface (<img src=\"...\">). Pass the same session id you publish with so the asset is grouped and cleaned up with it.",
  uploadAssetStdio:
    "Upload a binary asset (image, trace file, any file) and get back its id and URL. base64-encode the bytes in `data`. Then reference it: put {kind:'image', assetId} or {kind:'trace', assetId} in a post's surfaces, or embed the returned url in an html surface (<img src=\"...\">). Attached to this conversation's session.",
  getDesignGuide:
    "Fetch the design contract: post surfaces, html fragment rules, theme CSS variables, CDN allowlist, and the interactivity bridge. Call once per session before publishing.",
} as const;

export const HTTP_MCP_TOOLS = [
  {
    name: "publish_post",
    description: MCP_TOOL_DESCRIPTIONS.publishPostHttp,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: d.title },
        surfaces: MCP_SURFACES_JSON_SCHEMA,
        session: { type: "string", description: d.session },
        sessionTitle: { type: "string", description: d.sessionTitle },
        agent: { type: "string", description: d.agent },
      },
      required: ["title", "surfaces"],
    },
  },
  {
    name: "update_post",
    description: MCP_TOOL_DESCRIPTIONS.updatePost,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: d.surfaceId },
        surfaces: MCP_SURFACES_JSON_SCHEMA,
        title: { type: "string", description: d.replacementTitle },
      },
      required: ["id"],
    },
  },
  {
    name: "list_posts",
    description: MCP_TOOL_DESCRIPTIONS.listPostsHttp,
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Optional session id to scope the list" },
      },
    },
  },
  {
    name: "publish_surface",
    description: MCP_TOOL_DESCRIPTIONS.publishSurfaceHttp,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: d.title },
        parts: MCP_SURFACES_JSON_SCHEMA,
        session: { type: "string", description: d.session },
        sessionTitle: { type: "string", description: d.sessionTitle },
        agent: { type: "string", description: d.agent },
      },
      required: ["title", "parts"],
    },
  },
  {
    name: "update_surface",
    description: MCP_TOOL_DESCRIPTIONS.updateSurface,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: d.surfaceId },
        parts: MCP_SURFACES_JSON_SCHEMA,
        title: { type: "string", description: d.replacementTitle },
      },
      required: ["id"],
    },
  },
  {
    name: "publish_snippet",
    description: MCP_TOOL_DESCRIPTIONS.publishSnippet,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short human-readable title" },
        html: { type: "string", description: d.html },
        kits: { type: "array", items: { type: "string" }, description: d.surfaceKits },
        session: { type: "string", description: d.session },
        sessionTitle: { type: "string", description: "Session name (first publish only)" },
        agent: { type: "string", description: d.agent },
      },
      required: ["title", "html"],
    },
  },
  {
    name: "update_snippet",
    description: MCP_TOOL_DESCRIPTIONS.updateSnippet,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Surface id" },
        html: { type: "string", description: "Replacement HTML body fragment" },
        kits: { type: "array", items: { type: "string" }, description: d.surfaceKits },
        title: { type: "string", description: d.replacementTitle },
      },
      required: ["id"],
    },
  },
  {
    name: "wait_for_feedback",
    description: MCP_TOOL_DESCRIPTIONS.waitForFeedback,
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session id to watch" },
        afterSeq: { type: "number", description: d.afterSeq },
        timeoutSeconds: { type: "number", description: `${d.timeout} (default 60)` },
      },
      required: ["session"],
    },
  },
  {
    name: "reply_to_user",
    description: MCP_TOOL_DESCRIPTIONS.replyToUser,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", description: "Post whose comment thread to reply in" },
        surfaceId: { type: "string", description: "Deprecated alias of postId" },
        message: { type: "string", description: d.replyMessage },
        author: {
          type: "string",
          description:
            'Your agent name (default "agent"; "user" is reserved and coerced to "agent")',
        },
      },
      required: ["message"],
    },
  },
  {
    name: "list_surfaces",
    description: MCP_TOOL_DESCRIPTIONS.listSurfacesHttp,
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Optional session id to scope the list" },
      },
    },
  },
  {
    name: "upload_asset",
    description: MCP_TOOL_DESCRIPTIONS.uploadAsset,
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: d.assetData },
        contentType: { type: "string", description: d.assetContentType },
        filename: { type: "string", description: d.assetFilename },
        kind: { type: "string", enum: ["image", "trace", "file"], description: d.assetKind },
        session: { type: "string", description: d.assetSession },
      },
      required: ["data", "contentType"],
    },
  },
  {
    name: "get_design_guide",
    description: MCP_TOOL_DESCRIPTIONS.getDesignGuide,
    inputSchema: { type: "object", properties: {} },
  },
] as const;

const diffFileSchema = z.object({
  filename: z.string(),
  before: z.string(),
  after: z.string(),
  language: z.string().optional(),
});

const traceStepSchema = z.object({
  label: z.string().describe(d.traceLabel),
  kind: z.string().optional().describe(d.traceKind),
  detail: z.string().optional().describe(d.traceDetail),
  ts: z.string().optional().describe(d.traceTs),
});

const mcpPartSchema = z
  .object({
    kind: z.enum(PART_KIND_ENUM),
    html: z.string().optional().describe(d.surfaceHtml),
    kits: z.array(z.string()).optional().describe(d.surfaceKits),
    markdown: z.string().optional().describe(d.surfaceMarkdown),
    mermaid: z.string().optional().describe(d.surfaceMermaid),
    patch: z.string().optional().describe(d.surfacePatch),
    files: z.array(diffFileSchema).optional().describe(d.surfaceFiles),
    layout: z.enum(["unified", "split"]).optional(),
    assetId: z.string().optional().describe(d.surfaceAssetId),
    alt: z.string().optional().describe(d.imageAlt),
    caption: z.string().optional().describe(d.imageCaption),
    title: z.string().optional().describe(d.traceTitle),
    steps: z.array(traceStepSchema).optional().describe(d.traceSteps),
    text: z.string().optional().describe(d.terminalText),
    cols: z.number().optional().describe(d.terminalCols),
    data: z.unknown().optional().describe(d.surfaceData),
    code: z.string().optional().describe(d.surfaceCode),
    language: z.string().optional().describe(d.surfaceLanguage),
    lineStart: z.number().int().min(1).optional().describe(d.surfaceLineStart),
  })
  .describe(
    "A surface: html {kind:'html',html}; markdown {kind:'markdown',markdown} (prose); mermaid " +
      "{kind:'mermaid',mermaid} (diagram source → SVG); diff {kind:'diff',patch}; image " +
      "{kind:'image',assetId} (from upload_asset); trace {kind:'trace',steps} and/or {kind:'trace',assetId}; " +
      "terminal {kind:'terminal',text} (monospace output; ANSI SGR colors rendered); json {kind:'json',data} " +
      "(any JSON value → collapsible tree); code {kind:'code',code,language?,lineStart?} (highlighted source)",
  );

export const STDIO_MCP_INPUT_SCHEMAS = {
  publishPost: {
    title: z.string().describe(d.title),
    surfaces: z.array(mcpPartSchema).describe(MCP_SURFACES_DESCRIPTION),
    sessionTitle: z.string().optional().describe(d.stdioSessionTitle),
  },
  updatePost: {
    id: z.string().describe(d.surfaceId),
    surfaces: z.array(mcpPartSchema).optional().describe(d.replacementParts),
    title: z.string().optional().describe(d.replacementTitle),
  },
  publishSurface: {
    title: z.string().describe(d.title),
    parts: z.array(mcpPartSchema).describe(MCP_SURFACES_DESCRIPTION),
    sessionTitle: z.string().optional().describe(d.stdioSessionTitle),
  },
  updateSurface: {
    id: z.string().describe(d.surfaceId),
    parts: z.array(mcpPartSchema).optional().describe(d.replacementParts),
    title: z.string().optional().describe(d.replacementTitle),
  },
  publishSnippet: {
    title: z.string().describe("Short human-readable title shown above the snippet"),
    html: z.string().describe(d.html),
    kits: z.array(z.string()).optional().describe(d.surfaceKits),
    sessionTitle: z.string().optional().describe("Session name (first publish only)"),
  },
  updateSnippet: {
    id: z.string().describe("Surface id"),
    html: z.string().optional().describe("Replacement HTML body fragment"),
    kits: z.array(z.string()).optional().describe(d.surfaceKits),
    title: z.string().optional().describe(d.replacementTitle),
  },
  waitForFeedback: {
    timeoutSeconds: z
      .number()
      .min(0)
      .max(300)
      .optional()
      .describe(`${d.timeout} (default 120, 0 = check only)`),
  },
  replyToUser: {
    postId: z.string().optional().describe("Post whose comment thread to reply in"),
    surfaceId: z.string().optional().describe("Deprecated alias of postId"),
    message: z.string().describe(d.replyMessage),
  },
  uploadAsset: {
    data: z.string().describe(d.assetData),
    contentType: z.string().describe(d.assetContentType),
    filename: z.string().optional().describe(d.assetFilename),
    kind: z
      .enum(["image", "trace", "file"])
      .optional()
      .describe("Inferred from contentType if omitted"),
  },
} as const;

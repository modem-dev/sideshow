import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "@hono/node-server";
// @ts-expect-error The distributed Pi extension is intentionally standalone JavaScript.
import sideshowExtension from "../extensions/sideshow.js";
import { createApp } from "../server/app.ts";
import { JsonFileStore } from "../server/storage.ts";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, any>;
};

type ToolDefinition = {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: {
    properties?: Record<string, any>;
    required?: string[];
  };
  execute: (
    toolCallId: string,
    params: Record<string, any>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: ReturnType<typeof createContext>,
  ) => Promise<ToolResult>;
};

type CommandDefinition = {
  description: string;
  handler: (args: string, ctx: ReturnType<typeof createContext>) => Promise<void>;
};

type EventHandler = (event: Record<string, any>, ctx: ReturnType<typeof createContext>) => any;

function createPiHarness() {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, EventHandler[]>();
  const pi = {
    on(name: string, handler: EventHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
  };

  sideshowExtension(pi);

  return {
    tools,
    commands,
    eventNames: [...handlers.keys()],
    async emit(name: string, ctx: ReturnType<typeof createContext>) {
      for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
    },
    tool(name: string) {
      const tool = tools.get(name);
      assert.ok(tool, `tool ${name} was registered`);
      return tool;
    },
    command(name: string) {
      const command = commands.get(name);
      assert.ok(command, `command ${name} was registered`);
      return command;
    },
  };
}

function createContext(cwd: string, branch: any[] = []) {
  const statuses: Array<{ key: string; value: string }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    cwd,
    statuses,
    notifications,
    ui: {
      setStatus(key: string, value: string) {
        statuses.push({ key, value });
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    sessionManager: {
      getBranch() {
        return branch;
      },
    },
  };
}

async function invoke(
  harness: ReturnType<typeof createPiHarness>,
  name: string,
  params: Record<string, any>,
  ctx: ReturnType<typeof createContext>,
) {
  return harness.tool(name).execute("call-1", params, undefined, undefined, ctx);
}

function startServer(dir: string) {
  const store = new JsonFileStore(join(dir, "data.json"));
  const app = createApp({
    store,
    viewerHtml: "<html>viewer</html>",
    guideMarkdown: "# Sideshow design contract",
    setupText: "# setup",
    authToken: "test-token",
  });

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({
        url: `http://localhost:${info.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            (
              server as typeof server & { closeAllConnections?: () => void }
            ).closeAllConnections?.();
          }),
      });
    });
  });
}

function text(result: ToolResult) {
  return result.content.map((block) => block.text).join("");
}

function authInit(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      authorization: "Bearer test-token",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  };
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, authInit({ method: "POST", body: JSON.stringify(body) }));
  assert.equal(response.ok, true);
  return response.json() as Promise<any>;
}

function traceBranch(now: number) {
  const long = "x".repeat(2200);
  return [
    { type: "message", message: { role: "user", content: `Build it\n${long}`, timestamp: now } },
    {
      type: "message",
      timestamp: new Date(now + 1).toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Consider options\nprivately" },
          { type: "text", text: "I will inspect and update." },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "/tmp/a.ts" } },
          { type: "toolCall", name: "edit", arguments: { path: "src/b.ts" } },
          { type: "toolCall", name: "write", arguments: { path: "src/c.ts" } },
          { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
          { type: "toolCall", name: "web_fetch", arguments: { url: "https://example.com" } },
          { type: "toolCall", name: "web_search", arguments: { query: "sideshow" } },
          { type: "toolCall", name: "subagent", arguments: { action: "list" } },
          { type: "toolCall", name: "sideshow_list_surfaces", arguments: {} },
          { type: "toolCall", name: "Custom_TOOL_WITH_LONG_NAME", arguments: null },
          { type: "toolCall", name: "", arguments: {} },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "read-1",
        content: [{ type: "text", text: `file contents ${long}` }],
        timestamp: now + 2,
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "unknown",
        content: "ignored",
        timestamp: now + 3,
      },
    },
    {
      type: "message",
      message: {
        role: "bashExecution",
        command: "git status",
        output: "clean",
        timestamp: now + 4,
      },
    },
    {
      type: "message",
      message: { role: "user", content: [{ type: "image" }], timestamp: now + 5 },
    },
    { type: "other" },
  ];
}

// Keep the main flow sequential: the extension's remembered session and the
// server's exactly-once feedback cursor are the cross-call contract under test.
test(
  "the Pi extension contract works through a fake host and real server",
  { timeout: 10_000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "sideshow-pi-extension-"));
    const originalEnv = {
      url: process.env.SIDESHOW_URL,
      token: process.env.SIDESHOW_TOKEN,
      agent: process.env.SIDESHOW_AGENT,
      session: process.env.SIDESHOW_SESSION,
    };
    const server = await startServer(dir);
    let serverClosed = false;

    process.env.SIDESHOW_URL = `${server.url}/`;
    process.env.SIDESHOW_TOKEN = "test-token";
    process.env.SIDESHOW_AGENT = "contract-pi";
    delete process.env.SIDESHOW_SESSION;

    t.after(async () => {
      try {
        if (!serverClosed) await server.close();
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true });
        } finally {
          for (const [key, value] of Object.entries(originalEnv)) {
            const envName = `SIDESHOW_${key.toUpperCase()}`;
            if (value === undefined) delete process.env[envName];
            else process.env[envName] = value;
          }
        }
      }
    });

    const harness = createPiHarness();
    assert.deepEqual(
      [...harness.tools.keys()],
      [
        "sideshow_get_design_guide",
        "sideshow_publish_surface",
        "sideshow_update_surface",
        "sideshow_wait_for_feedback",
        "sideshow_reply_to_user",
        "sideshow_list_surfaces",
        "sideshow_upload_asset",
      ],
    );
    assert.deepEqual([...harness.commands.keys()], ["sideshow"]);
    assert.deepEqual(harness.eventNames, ["session_start", "turn_end"]);
    assert.deepEqual(harness.tool("sideshow_publish_surface").parameters.required, [
      "title",
      "parts",
    ]);
    assert.deepEqual(harness.tool("sideshow_update_surface").parameters.required, ["id"]);
    const replySchema = harness.tool("sideshow_reply_to_user").parameters;
    assert.deepEqual(replySchema.required, ["surfaceId", "message"]);
    assert.equal("session" in replySchema.properties!, false);
    const advertisedKinds = harness.tool("sideshow_publish_surface").parameters.properties?.parts
      .items.properties.kind.enum;
    for (const kind of [
      "html",
      "markdown",
      "mermaid",
      "diff",
      "image",
      "terminal",
      "json",
      "code",
    ]) {
      assert.ok(advertisedKinds.includes(kind), `publish schema includes ${kind}`);
    }
    assert.equal(advertisedKinds.includes("trace"), false);
    const advertisedFields = harness.tool("sideshow_publish_surface").parameters.properties?.parts
      .items.properties;
    for (const field of ["data", "code", "language", "lineStart"]) {
      assert.ok(field in advertisedFields, `publish schema includes ${field}`);
    }
    for (const tool of harness.tools.values()) {
      assert.ok(tool.promptSnippet);
      if (tool.name !== "sideshow_get_design_guide" && tool.name !== "sideshow_list_surfaces") {
        assert.ok(tool.promptGuidelines?.length);
      }
    }

    const ctx = createContext(dir, traceBranch(Date.now() - 1000));
    await harness.emit("session_start", ctx);
    assert.deepEqual(ctx.statuses.at(-1), {
      key: "sideshow",
      value: `sideshow localhost:${new URL(server.url).port}`,
    });

    const guide = await invoke(harness, "sideshow_get_design_guide", {}, ctx);
    assert.match(text(guide), /Sideshow design contract/);
    assert.equal(guide.details?.baseUrl, server.url);

    const published = await invoke(
      harness,
      "sideshow_publish_surface",
      {
        title: "Contract card",
        sessionTitle: "Extension contract",
        parts: [
          { kind: "markdown", markdown: "# Hello" },
          { kind: "mermaid", mermaid: "flowchart LR; A-->B" },
          { kind: "terminal", text: "\u001b[32mok\u001b[0m" },
        ],
      },
      ctx,
    );
    const surface = published.details!;
    assert.equal(surface.title, "Contract card");
    assert.match(text(published), new RegExp(`/p/${surface.id}`));
    assert.match(text(published), new RegExp(`sessionId: ${surface.sessionId}`));
    assert.equal(surface.baseUrl, server.url);

    await postJson(`${server.url}/api/comments`, {
      surface: surface.id,
      text: "Make the heading shorter",
      author: "user",
    });
    const updated = await invoke(
      harness,
      "sideshow_update_surface",
      { id: surface.id, title: "Short card", parts: [{ kind: "markdown", markdown: "# Hi" }] },
      ctx,
    );
    assert.match(text(updated), /version 2/);
    assert.match(text(updated), /User feedback delivered/);
    assert.match(text(updated), /Contract card: Make the heading shorter/);

    const emptyWait = await invoke(
      harness,
      "sideshow_wait_for_feedback",
      { timeoutSeconds: -10 },
      ctx,
    );
    assert.equal(text(emptyWait), "No new sideshow feedback.");

    await postJson(`${server.url}/api/comments`, {
      surface: surface.id,
      text: "Looks good",
      author: "user",
    });
    const waited = await invoke(
      harness,
      "sideshow_wait_for_feedback",
      { session: surface.sessionId, timeoutSeconds: 0 },
      ctx,
    );
    assert.match(text(waited), /Received 1 sideshow comment/);
    assert.match(text(waited), /Looks good/);
    assert.equal(waited.details?.sessionId, surface.sessionId);

    await postJson(`${server.url}/api/comments`, {
      surface: surface.id,
      text: "One more thought",
      author: "user",
    });
    const surfaceReply = await invoke(
      harness,
      "sideshow_reply_to_user",
      { surfaceId: surface.id, message: "Acknowledged", author: "review-pi" },
      ctx,
    );
    assert.match(text(surfaceReply), new RegExp(`on surface ${surface.id}`));
    assert.match(text(surfaceReply), /One more thought/);
    assert.equal(surfaceReply.details?.postId, surface.id);
    assert.equal(surfaceReply.details?.author, "review-pi");

    const second = await invoke(
      harness,
      "sideshow_publish_surface",
      {
        title: "Second card",
        session: surface.sessionId,
        agent: "override-agent",
        parts: [
          { kind: "html", html: "<strong>two</strong>" },
          { kind: "json", data: { status: "ok" } },
          { kind: "code", code: "const ok = true;", language: "ts", lineStart: 10 },
        ],
      },
      ctx,
    );
    assert.equal(second.details?.sessionId, surface.sessionId);

    const listed = await invoke(
      harness,
      "sideshow_list_surfaces",
      { session: surface.sessionId, limit: 1.9 },
      ctx,
    );
    assert.equal(listed.details?.surfaces.length, 2);
    assert.equal(text(listed).split("\n").length, 1);
    assert.match(text(listed), /\/p\//);

    const listedAll = await invoke(
      harness,
      "sideshow_list_surfaces",
      { all: true, limit: 10 },
      ctx,
    );
    assert.match(text(listedAll), new RegExp(String.raw`\[${surface.sessionId}\]`));
    assert.ok(Array.isArray(listedAll.details?.sessions));
    const publishedGroup = listedAll.details!.sessions.find(
      (group: any) => group.session.id === surface.sessionId,
    );
    assert.equal(publishedGroup.session.agent, "contract-pi");
    assert.equal(publishedGroup.session.cwd, dir);

    const imagePath = join(dir, "preview.PNG");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const uploadedFile = await invoke(
      harness,
      "sideshow_upload_asset",
      { path: "@preview.PNG", kind: "image" },
      ctx,
    );
    assert.equal(uploadedFile.details?.asset.contentType, "image/png");
    assert.equal(uploadedFile.details?.asset.byteLength, 4);
    assert.equal(uploadedFile.details?.sessionId, surface.sessionId);

    const uploadedData = await invoke(
      harness,
      "sideshow_upload_asset",
      {
        data: Buffer.from("trace data").toString("base64"),
        kind: "file",
        newSession: true,
        sessionTitle: "Trace-only session",
      },
      ctx,
    );
    const traceSession = uploadedData.details?.sessionId;
    assert.notEqual(traceSession, surface.sessionId);
    assert.equal(uploadedData.details?.asset.contentType, "application/octet-stream");
    assert.match(text(uploadedData), /10 bytes/);

    await harness.emit("turn_end", ctx);
    const traceResponse = (await fetch(
      `${server.url}/api/sessions/${traceSession}/trace`,
      authInit(),
    ).then((response) => response.json())) as { steps: any[] };
    const trace = traceResponse.steps;
    assert.ok(trace.length >= 10);
    assert.ok(trace.some((step) => step.kind === "prompt"));
    assert.ok(trace.some((step) => step.kind === "think"));
    assert.ok(
      trace.some((step) => step.kind === "read" && step.detail.includes("→ file contents")),
    );
    assert.ok(trace.some((step) => step.kind === "edit"));
    assert.ok(trace.some((step) => step.kind === "run"));
    assert.ok(trace.some((step) => step.kind === "web"));
    assert.ok(trace.some((step) => step.kind === "agent"));
    assert.ok(trace.some((step) => step.kind === "sideshow"));
    assert.ok(trace.every((step) => !step.detail || step.detail.length <= 1801));

    const command = harness.command("sideshow");
    await command.handler("", ctx);
    assert.match(ctx.notifications.at(-1)!.message, new RegExp(`session ${traceSession}`));
    await command.handler("reset", ctx);
    assert.equal(ctx.notifications.at(-1)!.message, "Reset remembered sideshow session");

    const scoped = createPiHarness();
    const scopedCtx = createContext(dir, [
      ...traceBranch(Date.now() - 1000),
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "sideshow_publish_surface",
          details: { sessionId: surface.sessionId },
        },
      },
    ]);
    await scoped.emit("session_start", scopedCtx);
    await scoped.emit("turn_end", scopedCtx);
    const scopedTrace = (await fetch(
      `${server.url}/api/sessions/${surface.sessionId}/trace`,
      authInit(),
    ).then((response) => response.json())) as { steps: any[] };
    assert.ok(scopedTrace.steps.some((step) => step.kind === "prompt"));

    const reconstructed = createPiHarness();
    const reconstructedCtx = createContext(dir, [
      {
        type: "message",
        message: { role: "toolResult", toolName: "read", details: { sessionId: "ignored" } },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "sideshow_publish_surface",
          details: { surface: { sessionId: surface.sessionId } },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "sideshow_upload_asset",
          details: { asset: { sessionId: traceSession } },
        },
      },
    ]);
    await reconstructed.emit("session_start", reconstructedCtx);
    assert.equal(reconstructedCtx.statuses.at(-1)?.value, `sideshow ${traceSession}`);
    const currentEmpty = await invoke(
      reconstructed,
      "sideshow_list_surfaces",
      {},
      reconstructedCtx,
    );
    assert.equal(text(currentEmpty), "No sideshow surfaces in this session.");

    process.env.SIDESHOW_SESSION = surface.sessionId;
    const configured = createPiHarness();
    const configuredCtx = createContext(dir);
    await configured.emit("session_start", configuredCtx);
    assert.equal(configuredCtx.statuses.at(-1)?.value, `sideshow ${surface.sessionId}`);
    await configured.command("sideshow").handler("reset", configuredCtx);
    await configured.command("sideshow").handler("", configuredCtx);
    assert.match(configuredCtx.notifications.at(-1)!.message, new RegExp(surface.sessionId));
    delete process.env.SIDESHOW_SESSION;

    const noSession = createPiHarness();
    const noSessionCtx = createContext(dir);
    await noSession.emit("turn_end", noSessionCtx);
    await assert.rejects(
      invoke(noSession, "sideshow_wait_for_feedback", {}, noSessionCtx),
      /No sideshow session yet/,
    );
    await assert.rejects(
      invoke(noSession, "sideshow_list_surfaces", {}, noSessionCtx),
      /Publish first, pass session, or set all=true/,
    );
    await assert.rejects(
      invoke(noSession, "sideshow_upload_asset", {}, noSessionCtx),
      /Provide either path or base64 data/,
    );
    const forcedSession = await invoke(
      noSession,
      "sideshow_publish_surface",
      {
        title: "Forced new session",
        session: surface.sessionId,
        newSession: true,
        parts: [{ kind: "json", data: [1, 2, 3] }],
      },
      noSessionCtx,
    );
    assert.notEqual(forcedSession.details?.sessionId, surface.sessionId);

    process.env.SIDESHOW_TOKEN = "wrong-token";
    await assert.rejects(
      invoke(harness, "sideshow_list_surfaces", { session: surface.sessionId }, ctx),
      /unauthorized/,
    );
    process.env.SIDESHOW_TOKEN = "test-token";

    const realFetch = globalThis.fetch;
    const waits: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/comments" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        assert.equal(body.surface, "requested-surface");
        return new Response(
          JSON.stringify({
            surfaceId: "legacy-surface",
            sessionId: "legacy-session",
            author: "contract-pi",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/api/comments") {
        waits.push(url.searchParams.get("wait")!);
        assert.equal(url.searchParams.get("author"), "user");
        if (url.searchParams.has("after")) assert.equal(url.searchParams.get("after"), "7");
        return new Response(JSON.stringify({ comments: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("plain failure", { status: 418, statusText: "Teapot" });
    };
    try {
      const clamped = await invoke(
        harness,
        "sideshow_wait_for_feedback",
        { session: surface.sessionId, timeoutSeconds: 9999, afterSeq: 7 },
        ctx,
      );
      assert.equal(text(clamped), "No new sideshow feedback.");
      await invoke(
        harness,
        "sideshow_wait_for_feedback",
        { session: surface.sessionId, timeoutSeconds: Infinity },
        ctx,
      );
      assert.deepEqual(waits, ["300", "60"]);
      const legacyReply = await invoke(
        harness,
        "sideshow_reply_to_user",
        { surfaceId: "requested-surface", message: "Legacy response" },
        ctx,
      );
      assert.match(text(legacyReply), /on surface legacy-surface/);
      await assert.rejects(
        invoke(harness, "sideshow_list_surfaces", { session: surface.sessionId }, ctx),
        /418 Teapot/,
      );
      await assert.rejects(invoke(harness, "sideshow_get_design_guide", {}, ctx), /418 Teapot/);
    } finally {
      globalThis.fetch = realFetch;
    }

    await server.close();
    serverClosed = true;
    await assert.rejects(
      invoke(harness, "sideshow_get_design_guide", {}, ctx),
      /server not reachable.*start it with "sideshow serve"/,
    );
    await assert.rejects(
      invoke(harness, "sideshow_list_surfaces", { session: surface.sessionId }, ctx),
      /server not reachable.*start it with "sideshow serve"/,
    );

    await reconstructed.emit("turn_end", reconstructedCtx);
  },
);

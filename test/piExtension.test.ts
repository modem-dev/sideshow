import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import sideshowExtension from "../extensions/sideshow.js";

const originalTuiStatus = process.env.SIDESHOW_TUI_STATUS;
const originalSession = process.env.SIDESHOW_SESSION;

type Status = [key: string, text: string | undefined];
type BranchEntry = {
  type: "message";
  message: {
    role: "toolResult";
    toolName: string;
    details?: { sessionId?: string };
  };
};
interface Context {
  cwd: string;
  sessionManager: { getBranch: () => BranchEntry[] };
  ui: {
    setStatus: (key: string, text: string | undefined) => void;
    notify: () => void;
  };
}
type Handler = (event: object, context: Context) => unknown;
type Command = { handler: (args: string, context: Context) => Promise<void> };
type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

afterEach(() => {
  if (originalTuiStatus === undefined) delete process.env.SIDESHOW_TUI_STATUS;
  else process.env.SIDESHOW_TUI_STATUS = originalTuiStatus;
  if (originalSession === undefined) delete process.env.SIDESHOW_SESSION;
  else process.env.SIDESHOW_SESSION = originalSession;
});

function loadExtension() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const tools = new Map<string, Tool>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
  };
  sideshowExtension(pi);
  return { handlers, commands, tools };
}

function context(statuses: Status[], branch: BranchEntry[] = []): Context {
  return {
    cwd: "/tmp/sideshow-extension-test",
    sessionManager: { getBranch: () => branch },
    ui: {
      setStatus(key, text) {
        statuses.push([key, text]);
      },
      notify() {},
    },
  };
}

function sessionEntry(sessionId: string, toolName = "sideshow_publish_surface"): BranchEntry {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName,
      details: { sessionId },
    },
  };
}

describe("Pi extension TUI status", () => {
  it("stays hidden until the conversation has a Sideshow session", () => {
    delete process.env.SIDESHOW_SESSION;
    delete process.env.SIDESHOW_TUI_STATUS;
    const { handlers } = loadExtension();
    const idleStatuses: Status[] = [];
    const activeStatuses: Status[] = [];

    handlers.get("session_start")!({}, context(idleStatuses));
    handlers.get("session_start")!({}, context(activeStatuses, [sessionEntry("session-a")]));

    assert.deepEqual(idleStatuses, [["sideshow", undefined]]);
    assert.deepEqual(activeStatuses, [["sideshow", "sideshow session-a"]]);
  });

  it("does not restore explicit sessions used only by read tools", () => {
    delete process.env.SIDESHOW_SESSION;
    delete process.env.SIDESHOW_TUI_STATUS;
    const { handlers } = loadExtension();
    const statuses: Status[] = [];
    const branch = [
      sessionEntry("active-session"),
      sessionEntry("wait-only-session", "sideshow_wait_for_feedback"),
      sessionEntry("list-only-session", "sideshow_list_surfaces"),
    ];

    handlers.get("session_start")!({}, context(statuses, branch));

    assert.deepEqual(statuses, [["sideshow", "sideshow active-session"]]);
  });

  it("follows Sideshow sessions across conversation tree branches", () => {
    delete process.env.SIDESHOW_SESSION;
    delete process.env.SIDESHOW_TUI_STATUS;
    const { handlers } = loadExtension();
    const statuses: Status[] = [];

    handlers.get("session_start")!({}, context(statuses, [sessionEntry("session-a")]));
    handlers.get("session_tree")!({}, context(statuses, [sessionEntry("session-b")]));
    handlers.get("session_tree")!({}, context(statuses));

    assert.deepEqual(statuses, [
      ["sideshow", "sideshow session-a"],
      ["sideshow", "sideshow session-b"],
      ["sideshow", undefined],
    ]);
  });

  it("resets a restored session to SIDESHOW_SESSION", async () => {
    delete process.env.SIDESHOW_TUI_STATUS;
    process.env.SIDESHOW_SESSION = "configured-session";
    const { commands, handlers } = loadExtension();
    const statuses: Status[] = [];
    const ctx = context(statuses, [sessionEntry("restored-session")]);

    handlers.get("session_start")!({}, ctx);
    await commands.get("sideshow")!.handler("reset", ctx);

    assert.deepEqual(statuses, [
      ["sideshow", "sideshow restored-session"],
      ["sideshow", "sideshow configured-session"],
    ]);
  });

  it("tracks the session returned by each publishing tool call and clears on reset", async (t) => {
    delete process.env.SIDESHOW_SESSION;
    delete process.env.SIDESHOW_TUI_STATUS;
    const returnedSessions = ["session-a", "session-b"];
    t.mock.method(globalThis, "fetch", async () => {
      const sessionId = returnedSessions.shift();
      return new Response(
        JSON.stringify({ id: `post-${sessionId}`, title: "Status test", sessionId }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const { commands, handlers, tools } = loadExtension();
    const statuses: Status[] = [];
    const ctx = context(statuses);
    const publish = tools.get("sideshow_publish_surface")!;

    handlers.get("session_start")!({}, ctx);
    await publish.execute(
      "call-a",
      { title: "Status test", parts: [{ kind: "markdown", markdown: "A" }], newSession: true },
      undefined,
      undefined,
      ctx,
    );
    await publish.execute(
      "call-b",
      { title: "Status test", parts: [{ kind: "markdown", markdown: "B" }], newSession: true },
      undefined,
      undefined,
      ctx,
    );
    await commands.get("sideshow")!.handler("reset", ctx);

    assert.deepEqual(statuses, [
      ["sideshow", undefined],
      ["sideshow", "sideshow session-a"],
      ["sideshow", "sideshow session-b"],
      ["sideshow", undefined],
    ]);
  });

  it("tracks sessions returned by update, reply, and upload tools", async (t) => {
    delete process.env.SIDESHOW_SESSION;
    delete process.env.SIDESHOW_TUI_STATUS;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = String(input);
      let body;
      if (url.includes("/api/surfaces/post-a")) {
        body = {
          id: "post-a",
          title: "Updated",
          version: 2,
          sessionId: "update-session",
        };
      } else if (url.includes("/api/comments")) {
        body = { id: "comment-a", sessionId: "reply-session" };
      } else {
        body = {
          id: "asset-a",
          contentType: "text/plain",
          byteLength: 1,
          url: "/a/asset-a",
          sessionId: "upload-session",
        };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { handlers, tools } = loadExtension();
    const statuses: Status[] = [];
    const ctx = context(statuses);
    handlers.get("session_start")!({}, ctx);

    await tools
      .get("sideshow_update_surface")!
      .execute("call-update", { id: "post-a", title: "Updated" }, undefined, undefined, ctx);
    await tools
      .get("sideshow_reply_to_user")!
      .execute(
        "call-reply",
        { message: "Done", session: "reply-session" },
        undefined,
        undefined,
        ctx,
      );
    await tools
      .get("sideshow_upload_asset")!
      .execute("call-upload", { data: "eA==", filename: "x.txt" }, undefined, undefined, ctx);

    assert.deepEqual(statuses, [
      ["sideshow", undefined],
      ["sideshow", "sideshow update-session"],
      ["sideshow", "sideshow reply-session"],
      ["sideshow", "sideshow upload-session"],
    ]);
  });

  it("keeps status hidden with SIDESHOW_TUI_STATUS=0", async (t) => {
    process.env.SIDESHOW_TUI_STATUS = "0";
    process.env.SIDESHOW_SESSION = "configured-session";
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ id: "post-hidden", title: "Hidden status", sessionId: "new-session" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const { handlers, commands, tools } = loadExtension();
    const statuses: Status[] = [];
    const ctx = context(statuses, [sessionEntry("restored-session")]);

    handlers.get("session_start")!({}, ctx);
    await tools.get("sideshow_publish_surface")!.execute(
      "call-hidden",
      {
        title: "Hidden status",
        parts: [{ kind: "markdown", markdown: "Hidden" }],
        newSession: true,
      },
      undefined,
      undefined,
      ctx,
    );
    await commands.get("sideshow")!.handler("reset", ctx);

    assert.deepEqual(statuses, [
      ["sideshow", undefined],
      ["sideshow", undefined],
      ["sideshow", undefined],
    ]);
  });
});

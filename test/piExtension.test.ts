import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import sideshowExtension from "../extensions/sideshow.js";

const originalTuiStatus = process.env.SIDESHOW_TUI_STATUS;

type Status = [key: string, text: string | undefined];
interface Context {
  sessionManager: { getBranch: () => never[] };
  ui: {
    setStatus: (key: string, text: string | undefined) => number;
    notify: () => void;
  };
}
type Handler = (event: object, context: Context) => void;
type Command = { handler: (args: string, context: Context) => Promise<void> };

afterEach(() => {
  if (originalTuiStatus === undefined) delete process.env.SIDESHOW_TUI_STATUS;
  else process.env.SIDESHOW_TUI_STATUS = originalTuiStatus;
});

function loadExtension() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    registerTool() {},
  };
  sideshowExtension(pi);
  return { handlers, commands };
}

function context(statuses: Status[]) {
  return {
    sessionManager: { getBranch: () => [] },
    ui: {
      setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
      notify() {},
    },
  };
}

describe("Pi extension TUI status", () => {
  it("shows status by default", () => {
    delete process.env.SIDESHOW_TUI_STATUS;
    const { handlers } = loadExtension();
    const statuses: Status[] = [];

    handlers.get("session_start")!({}, context(statuses));

    assert.deepEqual(statuses, [["sideshow", "sideshow localhost:8228"]]);
  });

  it("clears status when SIDESHOW_TUI_STATUS=0", async () => {
    process.env.SIDESHOW_TUI_STATUS = "0";
    const { handlers, commands } = loadExtension();
    const statuses: Status[] = [];
    const ctx = context(statuses);

    handlers.get("session_start")!({}, ctx);
    await commands.get("sideshow")!.handler("reset", ctx);

    assert.deepEqual(statuses, [
      ["sideshow", undefined],
      ["sideshow", undefined],
    ]);
  });
});

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import sideshowExtension from "../extensions/sideshow.js";

const originalTuiStatus = process.env.SIDESHOW_TUI_STATUS;

afterEach(() => {
  if (originalTuiStatus === undefined) delete process.env.SIDESHOW_TUI_STATUS;
  else process.env.SIDESHOW_TUI_STATUS = originalTuiStatus;
});

function loadExtension() {
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool() {},
  };
  sideshowExtension(pi);
  return { handlers, commands };
}

function context(statuses) {
  return {
    sessionManager: { getBranch: () => [] },
    ui: {
      setStatus: (key, text) => statuses.push([key, text]),
      notify() {},
    },
  };
}

describe("Pi extension TUI status", () => {
  it("shows status by default", () => {
    delete process.env.SIDESHOW_TUI_STATUS;
    const { handlers } = loadExtension();
    const statuses = [];

    handlers.get("session_start")({}, context(statuses));

    assert.deepEqual(statuses, [["sideshow", "sideshow localhost:8228"]]);
  });

  it("clears status when SIDESHOW_TUI_STATUS=0", async () => {
    process.env.SIDESHOW_TUI_STATUS = "0";
    const { handlers, commands } = loadExtension();
    const statuses = [];
    const ctx = context(statuses);

    handlers.get("session_start")({}, ctx);
    await commands.get("sideshow").handler("reset", ctx);

    assert.deepEqual(statuses, [
      ["sideshow", undefined],
      ["sideshow", undefined],
    ]);
  });
});

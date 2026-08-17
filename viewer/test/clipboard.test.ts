import { afterEach, expect, test, vi } from "vitest";
import { writeClipboard } from "../src/clipboard.ts";

// A copy whose text is still being fetched has to be claimed inside the user
// gesture or Safari drops the permission — writeClipboard hands the PROMISE to a
// ClipboardItem where it can, and only falls back to awaiting.
function stubClipboard(impl: Partial<Clipboard>) {
  Object.defineProperty(navigator, "clipboard", { value: impl, configurable: true });
  return impl;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(globalThis, "ClipboardItem");
});

test("a ready string goes straight to writeText", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  stubClipboard({ writeText });
  expect(await writeClipboard("hello")).toBe(true);
  expect(writeText).toHaveBeenCalledWith("hello");
});

test("pending text is claimed as a promise-valued ClipboardItem, not awaited first", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  const writeText = vi.fn().mockResolvedValue(undefined);
  stubClipboard({ write, writeText });
  const items: unknown[] = [];
  class FakeClipboardItem {
    constructor(data: Record<string, unknown>) {
      items.push(data);
    }
  }
  Object.defineProperty(globalThis, "ClipboardItem", {
    value: FakeClipboardItem,
    configurable: true,
  });

  let resolve!: (text: string) => void;
  const pending = new Promise<string>((r) => (resolve = r));
  const done = writeClipboard(pending);
  // The item is constructed before the text exists — that is the whole point.
  expect(items).toHaveLength(1);
  resolve("# post");
  expect(await done).toBe(true);
  expect(write).toHaveBeenCalled();
  expect(writeText).not.toHaveBeenCalled();
});

test("falls back to awaiting the text where promise-valued items are rejected", async () => {
  const write = vi.fn().mockRejectedValue(new Error("no promises here"));
  const writeText = vi.fn().mockResolvedValue(undefined);
  stubClipboard({ write, writeText });
  Object.defineProperty(globalThis, "ClipboardItem", {
    value: class {},
    configurable: true,
  });

  expect(await writeClipboard(Promise.resolve("# post"))).toBe(true);
  expect(writeText).toHaveBeenCalledWith("# post");
});

test("reports failure instead of throwing, so the caller can toast", async () => {
  stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
  expect(await writeClipboard("hello")).toBe(false);

  // A failed fetch behind the text must not escape either.
  stubClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
  expect(await writeClipboard(Promise.reject(new Error("offline")))).toBe(false);
});

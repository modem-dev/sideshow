// Clipboard writes, including the awkward async case.
//
// A copy whose text isn't ready yet (it's being fetched) can't just await and
// then call writeText: Safari ties clipboard permission to the user gesture, and
// the gesture is spent by the time the fetch resolves. The spec's answer is a
// ClipboardItem holding a PROMISE of the text — claimed synchronously inside the
// gesture, resolved after. Where that isn't supported we fall back to awaiting
// and writing, which is fine in Chromium.
export async function writeClipboard(text: string | Promise<string>): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (!clipboard) return false;
  try {
    if (typeof text === "string") {
      await clipboard.writeText(text);
      return true;
    }
    const ClipboardItemCtor = globalThis.ClipboardItem;
    if (ClipboardItemCtor && clipboard.write) {
      try {
        const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
        await clipboard.write([new ClipboardItemCtor({ "text/plain": blob })]);
        return true;
      } catch {
        // Older Chromium rejects a promise-valued ClipboardItem outright; the
        // await path below still works there. A promise is replayable, so
        // resolving it a second time costs nothing.
      }
    }
    await clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}

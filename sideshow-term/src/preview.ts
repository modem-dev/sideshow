// Headless render: STML markup -> a plain-text frame. Used by the CLI's
// `render` command (preview a snippet without the live viewer) and by tests.
// Bun only.

import { createTestRenderer } from "@opentui/core/testing";
import { buildDocument } from "./render.ts";

export interface RenderOptions {
  width?: number;
  height?: number;
}

export interface RenderResult {
  frame: string;
  errors: string[];
}

export async function renderToString(
  markup: string,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  const width = opts.width ?? 80;
  // Layout height is unknown before render, so render into a tall buffer and
  // trim the blank tail afterwards.
  const height = opts.height ?? 120;
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width, height });
  const { root, errors } = buildDocument(renderer, markup);
  renderer.root.add(root);
  await renderOnce();
  const lines = captureCharFrame()
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  renderer.destroy();
  return { frame: lines.join("\n"), errors };
}

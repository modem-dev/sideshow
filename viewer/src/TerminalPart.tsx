import { createMemo } from "solid-js";
import { AnsiUp } from "ansi_up";
import { escapeHtml } from "../../server/surfacePage.ts";
import type { TerminalPart as TerminalPartData } from "./api.ts";
import { SandboxedPart } from "./SandboxedPart.tsx";

// The terminal window's styles, shipped into the sandbox iframe. The terminal is
// intentionally a dark window regardless of theme (ANSI assumes a dark backdrop);
// the --term-* vars come from viewerThemeCss so it adopts the theme's hue.
const TERM_CSS = `
body { margin: 0; background: var(--term-bg); }
.term-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; background: var(--term-bar);
  border-bottom: 0.5px solid #000;
}
.term-dots { display: inline-flex; gap: 6px; }
.term-dots span { width: 11px; height: 11px; border-radius: 50%; background: #555; }
.term-dots span:nth-child(1) { background: #ff5f56; }
.term-dots span:nth-child(2) { background: #ffbd2e; }
.term-dots span:nth-child(3) { background: #27c93f; }
.term-title { font-size: 11.5px; color: var(--term-title); font-family: ui-monospace, monospace; }
.term-body {
  margin: 0; padding: 12px 14px; overflow-x: auto; white-space: pre;
  color: var(--term-fg);
  font: 12.5px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  tab-size: 8;
}
`;

// Resolve carriage returns before AnsiUp (which only understands SGR, not
// cursor motion). A bare `\r` returns the cursor to column 0, so progress bars
// and spinners — npm/pip/cargo/git/docker all do this — redraw a line many
// times in one "line". Normalize CRLF first, then collapse each line to the
// text after its final `\r` (last redraw wins). This is not VT emulation; it is
// just enough that captured build/download logs show their final state instead
// of every stacked frame. Cursor-addressing TUIs remain out of scope.
function resolveCarriageReturns(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const lastCr = line.lastIndexOf("\r");
      return lastCr === -1 ? line : line.slice(lastCr + 1);
    })
    .join("\n");
}

// Render terminal output as a styled terminal window inside the same
// opaque-origin sandbox as the other rich parts. AnsiUp converts SGR escapes to
// inline-styled <span>s and HTML-escapes everything else (escape_html defaults
// to true); the whole window is built as a STRING here (safe — not a DOM sink)
// and only parsed inside the iframe, so even an ansi_up regression can't reach
// the board. SGR-only for now: cursor-addressing sequences are ignored — the
// wire shape (see TerminalPart in server/types.ts) is renderer-agnostic so a
// full VT emulator can replace this later without changing storage, CLI, or MCP.
export function TerminalPart(props: { part: TerminalPartData }) {
  const body = createMemo(() => {
    const au = new AnsiUp();
    au.use_classes = false; // inline rgb styles — no class palette to ship
    const ansi = au.ansi_to_html(resolveCarriageReturns(props.part.text ?? ""));
    const title = escapeHtml(props.part.title ?? "terminal");
    const width = props.part.cols ? ` style="width:${Number(props.part.cols)}ch"` : "";
    return (
      `<div class="term-bar"><span class="term-dots" aria-hidden="true">` +
      `<span></span><span></span><span></span></span>` +
      `<span class="term-title">${title}</span></div>` +
      `<pre class="term-body"${width}>${ansi}</pre>`
    );
  });
  return <SandboxedPart class="partframe termframe" body={body()} css={TERM_CSS} />;
}

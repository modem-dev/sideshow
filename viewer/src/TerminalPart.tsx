import { createMemo } from "solid-js";
import { AnsiUp } from "ansi_up";
import type { TerminalPart as TerminalPartData } from "./api.ts";

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

// Render terminal output as a styled terminal window. The text may carry ANSI
// SGR escapes (colors/bold/italic/underline); AnsiUp converts those to
// inline-styled <span>s and — critically — HTML-escapes everything else
// (escape_html defaults to true). This part renders in the TRUSTED viewer (it
// never goes through the sandboxed iframe), so we only ever set AnsiUp's
// escaped output as innerHTML; the raw agent-supplied text is never injected.
// SGR-only for now: cursor-addressing sequences are ignored — the wire shape
// (see TerminalPart in server/types.ts) is renderer-agnostic so a full VT
// emulator can replace this later without changing storage, CLI, or MCP.
export function TerminalPart(props: { part: TerminalPartData }) {
  const html = createMemo(() => {
    const au = new AnsiUp();
    au.use_classes = false; // inline rgb styles — no class palette to ship
    return au.ansi_to_html(resolveCarriageReturns(props.part.text ?? ""));
  });
  return (
    <div class="terminalpart">
      <div class="term-bar">
        <span class="term-dots" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </span>
        <span class="term-title">{props.part.title ?? "terminal"}</span>
      </div>
      <pre
        class="term-body"
        style={props.part.cols ? { width: `${props.part.cols}ch` } : undefined}
        // eslint-disable-next-line solid/no-innerhtml -- AnsiUp escapes input (escape_html)
        innerHTML={html()}
      ></pre>
    </div>
  );
}

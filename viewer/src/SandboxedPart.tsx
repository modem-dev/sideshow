import { createMemo, onCleanup, onMount } from "solid-js";
import { renderSandboxedPart } from "../../server/surfacePage.ts";
import { themeById } from "../../server/themes.ts";
import { activeTheme } from "./theme.ts";

// location.origin is constant for the page lifetime — read it once, not per
// srcdoc rebuild.
const ORIGIN = location.origin;

// Size a surface iframe from a height the in-frame bridge reported. Shared by
// SandboxedPart (rich/comment frames) and App's bridge handler (html-part
// frames) so every sandboxed surface clamps to the same bounds — min one line,
// max generous enough for a long diff/markdown without runaway growth.
const MIN_H = 24;
const MAX_H = 4000;
export function applyFrameHeight(iframe: HTMLIFrameElement, reportedHeight: unknown): void {
  iframe.style.height = Math.min(Math.max(Number(reportedHeight), MIN_H), MAX_H) + "px";
}

// Renders agent-produced markup (markdown, mermaid, diff, terminal, code) inside a sandboxed
// iframe, instead of innerHTML in the trusted viewer. The caller renders the
// part to a STRING (string building is not a DOM sink, so it is safe in the
// trusted origin); the markup only becomes live DOM inside this iframe, where
// CSP allows only the nonce-bearing bridge script. The frame is same-origin to
// avoid Chrome 149's opaque-origin srcdoc layout bug, so blocking injected
// scripts is the isolation boundary. `body`/`css` are reactive — a theme switch
// rebuilds the doc and reloads the frame (the same way Card reloads html-part
// iframes on theme).
//
// Resize is handled locally: the bridge in the doc posts its content height, and
// each frame sizes itself from messages whose source is its own contentWindow.
// (Link clicks and the session-switch shortcut ride App's global bridge handler,
// which keys off message type, not the frame registry.)
export function SandboxedPart(props: { body: string; css: string; class?: string }) {
  let frame!: HTMLIFrameElement;

  const doc = createMemo(() =>
    renderSandboxedPart({
      body: props.body,
      css: props.css,
      origin: ORIGIN,
      theme: themeById(activeTheme()),
    }),
  );

  onMount(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== frame.contentWindow) return;
      const d = ev.data as { __sideshow?: boolean; type?: string; height?: number } | null;
      if (!d || !d.__sideshow || d.type !== "resize") return;
      applyFrameHeight(frame, d.height);
    };
    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
  });

  return (
    <iframe
      ref={(el) => (frame = el)}
      class={props.class ?? "partframe"}
      sandbox="allow-scripts allow-same-origin"
      srcdoc={doc()}
    ></iframe>
  );
}

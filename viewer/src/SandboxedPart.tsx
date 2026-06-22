import { createMemo, onCleanup, onMount } from "solid-js";
import { renderSandboxedPart } from "../../server/surfacePage.ts";
import { themeById } from "../../server/themes.ts";
import { activeTheme, resolvedMode } from "./theme.ts";

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

// Renders agent-produced markup (markdown, mermaid, diff) inside the SAME
// opaque-origin sandbox html parts use, instead of innerHTML in the trusted
// viewer. The caller renders the part to a STRING (string building is not a DOM
// sink, so it is safe in the trusted origin); the markup only becomes live DOM
// inside this iframe, where an opaque origin + tight CSP contain any sanitizer
// regression. `body`/`css` are reactive — a theme switch rebuilds the doc and
// reloads the frame (the same way Card reloads html-part iframes on theme).
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
      mode: resolvedMode(),
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

    // Chrome field-trial workaround: certain Chrome 149 A/B experiments break
    // layout measurement in opaque-origin srcdoc iframes — scrollHeight,
    // offsetHeight, innerWidth all read as 0.  The bridge may fire with only
    // the body-padding height (≤ MIN_H) because the content was never laid
    // out, then never re-fire because no resize occurs.  Re-setting the
    // srcdoc attribute forces a fresh HTML parse that consistently recovers
    // layout.  One retry after 2 s is enough; the re-parsed bridge fires
    // within ~60 ms.
    const retryId = setTimeout(() => {
      if (frame.isConnected && frame.srcdoc && frame.offsetHeight <= MIN_H) {
        const s = frame.srcdoc;
        frame.srcdoc = "";
        requestAnimationFrame(() => {
          frame.srcdoc = s;
        });
      }
    }, 2000);
    onCleanup(() => clearTimeout(retryId));
  });

  return (
    <iframe
      ref={(el) => (frame = el)}
      class={props.class ?? "partframe"}
      sandbox="allow-scripts"
      srcdoc={doc()}
    ></iframe>
  );
}

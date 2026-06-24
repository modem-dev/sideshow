import { createEffect, createMemo, onCleanup, onMount } from "solid-js";
import { renderSandboxedPart } from "../../server/surfacePage.ts";
import { themeById } from "../../server/themes.ts";
import { api, appPath } from "./api.ts";
import { activeTheme, resolvedMode } from "./theme.ts";

// location.origin is constant for the page lifetime — read it once, not per
// doc rebuild.
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
// The doc is staged at /f/:id and loaded by real URL — exactly like an html
// part at /s/:id — not srcdoc/blob. The response carries a `sandbox` CSP header,
// so the frame is opaque-origin (identical isolation), and a real navigation
// avoids a Chrome layout bug that only afflicts in-memory iframe documents
// (srcdoc/blob), where the heavier async-rendered parts never lay out. The
// server has no markup for a rich part (it renders here), so we POST the string
// and point the frame at the id it returns.
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

  // Stage the doc at /f/:id whenever it changes (theme switch, body/css update,
  // async render completing) and point the frame there. POST is async, so a
  // sequence guard drops a stale response if a newer doc raced ahead of it.
  let seq = 0;
  createEffect(() => {
    const html = doc();
    const mine = ++seq;
    void api<{ id: string }>("/api/frames", { method: "POST", body: JSON.stringify({ html }) })
      .then(({ id }) => {
        if (mine === seq) frame.src = appPath(`/f/${id}`);
      })
      .catch(() => {});
  });

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
      sandbox="allow-scripts"
    ></iframe>
  );
}

import { createSignal, onCleanup, onMount } from "solid-js";
import { WTerm } from "@wterm/dom";
import "@wterm/dom/css";
import type { ScreenPart as ScreenPartData } from "./api.ts";

// A live (or recorded) terminal panel. Unlike the SGR-only `terminal` part,
// this drives a real VT emulator (wterm, a Zig core compiled to WASM, base64
// inlined into the bundle), so cursor moves / screen clears / frame diffs from
// a TUI resolve into a grid. Bytes are written verbatim into the emulator; this
// renders in the trusted viewer (no iframe) — wterm only ever produces DOM, it
// never executes the stream as markup.
//
// Two sources, one renderer: a finished stream carries its bytes inline as
// `snapshot` (replayed once); a live stream is subscribed over SSE at
// /api/streams/:id/events, which replays the buffer-so-far then streams deltas.

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function ScreenPart(props: { part: ScreenPartData }) {
  let mount!: HTMLDivElement;
  const [status, setStatus] = createSignal<"connecting" | "live" | "ended">("connecting");

  onMount(() => {
    let disposed = false;
    let term: WTerm | undefined;
    let es: EventSource | undefined;
    let ready = false;
    const pending: Uint8Array[] = [];
    const write = (bytes: Uint8Array) => {
      pending.push(bytes);
      if (ready && term) {
        for (const b of pending) term.write(b);
        pending.length = 0;
      }
    };

    void (async () => {
      term = new WTerm(mount, {
        cols: props.part.cols ?? 80,
        rows: props.part.rows ?? 24,
        autoResize: false,
        cursorBlink: false,
      });
      await term.init();
      if (disposed) {
        term.destroy();
        return;
      }
      ready = true;

      // Finished stream persisted into the part: replay its bytes and stop.
      if (props.part.snapshot) {
        write(b64ToBytes(props.part.snapshot));
        setStatus("ended");
        return;
      }

      // Live: replay the buffer-so-far, then follow deltas.
      setStatus("live");
      es = new EventSource(`/api/streams/${props.part.streamId}/events`);
      es.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as { type: string; b64?: string };
        if (m.type === "data" && typeof m.b64 === "string") write(b64ToBytes(m.b64));
        else if (m.type === "end") {
          setStatus("ended");
          es?.close();
        }
      };
      es.onerror = () => setStatus("ended");
      write(new Uint8Array()); // flush anything queued before init resolved
    })().catch(() => setStatus("ended"));

    onCleanup(() => {
      disposed = true;
      es?.close();
      try {
        term?.destroy();
      } catch {
        // ignore teardown errors
      }
      term = undefined;
    });
  });

  return (
    <div class="screenpart">
      <div class="term-bar">
        <span class="term-dots" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </span>
        <span class="term-title">{props.part.title ?? "terminal"}</span>
        <span class="screen-status" data-status={status()}>
          {status() === "live" ? "● live" : status() === "ended" ? "ended" : "…"}
        </span>
      </div>
      <div class="screen-mount" ref={(el) => (mount = el)}></div>
    </div>
  );
}

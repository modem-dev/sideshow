import { createSignal, For, onMount, Show } from "solid-js";
import type { TracePart as TracePartData, TraceStep } from "./api.ts";

// Render an agent trace as a step timeline the user can scan beside the surface.
// Steps may travel inline in the part, or live in an uploaded JSON/JSONL asset
// (assetId) — which we also offer for download. When only an assetId is given we
// fetch it and render it if it parses to an array of steps.
export function TracePart(props: { part: TracePartData }) {
  const [steps, setSteps] = createSignal<TraceStep[]>(props.part.steps ?? []);
  const [note, setNote] = createSignal<string | null>(null);

  onMount(() => {
    if ((props.part.steps?.length ?? 0) > 0 || !props.part.assetId) return;
    void fetch(`/a/${props.part.assetId}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => setSteps(parseTrace(text)))
      .catch(() => setNote("Trace file unavailable — it may have been evicted."));
  });

  return (
    <div class="tracepart">
      <div class="trace-head">
        <span class="trace-title">{props.part.title ?? "Agent trace"}</span>
        <Show when={props.part.assetId}>
          <a class="trace-dl" href={`/a/${props.part.assetId}`} target="_blank" rel="noopener">
            download ↓
          </a>
        </Show>
      </div>
      <Show when={note()}>
        <div class="asset-gone">{note()}</div>
      </Show>
      <ol class="trace-steps">
        <For each={steps()}>{(step) => <TraceRow step={step} />}</For>
      </ol>
    </div>
  );
}

function TraceRow(props: { step: TraceStep }) {
  const [open, setOpen] = createSignal(false);
  const hasDetail = () => !!props.step.detail;
  return (
    <li class="trace-step" classList={{ open: open() }}>
      <div
        class="trace-row"
        classList={{ clickable: hasDetail() }}
        onClick={() => hasDetail() && setOpen(!open())}
      >
        <Show when={props.step.kind}>
          <span class="trace-kind">{props.step.kind}</span>
        </Show>
        <span class="trace-label">{props.step.label}</span>
        <Show when={props.step.ts}>
          <span class="trace-ts">{props.step.ts}</span>
        </Show>
      </div>
      <Show when={hasDetail() && open()}>
        <pre class="trace-detail">{props.step.detail}</pre>
      </Show>
    </li>
  );
}

// Accept a JSON array of steps, a single JSON object, or JSONL (one object per
// line). Anything missing a string `label` is dropped; a bare string line
// becomes a label-only step.
function parseTrace(text: string): TraceStep[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const toStep = (v: unknown): TraceStep | null => {
    if (typeof v === "string") return { label: v };
    if (v && typeof v === "object" && typeof (v as any).label === "string") {
      const o = v as any;
      return {
        label: o.label,
        ...(typeof o.kind === "string" && { kind: o.kind }),
        ...(typeof o.detail === "string" && { detail: o.detail }),
        ...(typeof o.ts === "string" && { ts: o.ts }),
      };
    }
    return null;
  };
  try {
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map(toStep).filter((s): s is TraceStep => s !== null);
  } catch {
    // not a single JSON document — try JSONL
    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return toStep(JSON.parse(line));
        } catch {
          return { label: line };
        }
      })
      .filter((s): s is TraceStep => s !== null);
  }
}

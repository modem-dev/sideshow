import { createMemo, createSignal, For, Show } from "solid-js";
import type { Surface, TraceStep } from "./api.ts";
import { Card } from "./Card.tsx";
import { streamLoading, surfaces, traceSteps } from "./state.ts";

// Treatment E, refined (approach 2): a left rail where ONLY the anchors get a
// node — user prompts and published surfaces. Between them the work reads as
// quiet connective tissue: the agent's responses as plain prose, and all of a
// turn's tool calls collapsed into ONE summary line (run ×7 · read ×2),
// expandable. A "turn" runs from one prompt to the next. Steps are the real
// session trace (synced from the transcript) interleaved with surfaces by time.

interface Gap {
  surface: Surface | null; // the surface this gap leads into; null = trailing
  steps: TraceStep[];
}

function buildGaps(surfs: readonly Surface[], steps: readonly TraceStep[]): Gap[] {
  const gaps: Gap[] = surfs.map((s) => ({ surface: s, steps: [] }));
  gaps.push({ surface: null, steps: [] });
  const at = (s: Surface) => Date.parse(s.createdAt);
  for (const step of steps) {
    const t = step.ts ? Date.parse(step.ts) : NaN;
    let idx = gaps.length - 1; // default: trailing
    if (!Number.isNaN(t)) {
      const found = surfs.findIndex((s) => at(s) >= t);
      if (found >= 0) idx = found;
    }
    gaps[idx].steps.push(step);
  }
  return gaps;
}

// A turn: a prompt (or the lead-in before one), its prose responses, and the
// tool calls it ran. Commands aggregate across the whole turn into one summary.
interface Turn {
  prompt: TraceStep | null;
  responses: TraceStep[];
  commands: TraceStep[];
}

function groupTurns(steps: readonly TraceStep[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  const ensure = () => {
    if (!cur) {
      cur = { prompt: null, responses: [], commands: [] };
      turns.push(cur);
    }
    return cur;
  };
  for (const s of steps) {
    if (s.kind === "prompt") {
      cur = { prompt: s, responses: [], commands: [] };
      turns.push(cur);
    } else if (s.kind === "say") {
      ensure().responses.push(s);
    } else {
      ensure().commands.push(s);
    }
  }
  return turns;
}

export function SessionTimeline() {
  const gaps = createMemo(() => buildGaps(surfaces, traceSteps()));
  const empty = () => !streamLoading() && surfaces.length === 0 && traceSteps().length === 0;
  return (
    <div class="timeline">
      <Show when={empty()}>
        <div class="empty">No surfaces in this session yet.</div>
      </Show>
      <For each={gaps()}>
        {(gap) => (
          <>
            <For each={groupTurns(gap.steps)}>{(turn) => <TurnBlock turn={turn} />}</For>
            <Show when={gap.surface}>
              {(s) => (
                <div class="tl-surface">
                  <span class="tl-node"></span>
                  <Card surface={s()} />
                </div>
              )}
            </Show>
          </>
        )}
      </For>
      <Show when={surfaces.length > 0 || traceSteps().length > 0}>
        <div class="tl-row tl-tail">
          <div class="body">waiting for feedback…</div>
        </div>
      </Show>
    </div>
  );
}

function TurnBlock(props: { turn: Turn }) {
  return (
    <>
      <Show when={props.turn.prompt}>{(p) => <TextRow kind="prompt" step={p()} />}</Show>
      <Responses steps={props.turn.responses} />
      <Show when={props.turn.commands.length > 0}>
        <CommandSummary steps={props.turn.commands} />
      </Show>
    </>
  );
}

// The agent's narration is the noisiest, most repetitive part of a turn. Keep
// the two that carry meaning — the intent (first) and the outcome (last) — and
// fold everything between into a "··· N more notes ···" line you can open.
function Responses(props: { steps: TraceStep[] }) {
  const [open, setOpen] = createSignal(false);
  const steps = () => props.steps;
  return (
    <Show
      when={steps().length > 2}
      fallback={<For each={steps()}>{(r) => <TextRow kind="response" step={r} />}</For>}
    >
      <TextRow kind="response" step={steps()[0]} />
      <div class="tl-row tl-notes-fold">
        <div class="body tl-clickable" onClick={() => setOpen(!open())}>
          {open() ? "··· hide notes ···" : `··· ${steps().length - 2} more notes ···`}
        </div>
      </div>
      <Show when={open()}>
        <For each={steps().slice(1, -1)}>{(r) => <TextRow kind="response" step={r} />}</For>
      </Show>
      <TextRow kind="response" step={steps()[steps().length - 1]} />
    </Show>
  );
}

// A prompt (with its rail node) or a response (no marker): first line, expanding
// to the full text on click.
function TextRow(props: { kind: "prompt" | "response"; step: TraceStep }) {
  const [open, setOpen] = createSignal(false);
  const detail = () => props.step.detail;
  const more = () => !!detail() && detail() !== props.step.label;
  return (
    <div class={`tl-row tl-${props.kind}`}>
      <Show when={props.kind === "prompt"}>
        <span class="tl-marker prompt"></span>
      </Show>
      <div class="body">
        <div classList={{ "tl-clickable": more() }} onClick={() => more() && setOpen(!open())}>
          {props.step.label}
        </div>
        <Show when={open() && more()}>
          <pre class="tl-detail">{detail()}</pre>
        </Show>
      </div>
    </div>
  );
}

// All of a turn's tool calls, folded into one line summarized by kind. No
// marker. Collapsed by default — the detail people won't read stays hidden.
function CommandSummary(props: { steps: TraceStep[] }) {
  const [open, setOpen] = createSignal(false);
  const summary = createMemo(() => {
    const by = new Map<string, number>();
    for (const s of props.steps) {
      const k = s.kind ?? "step";
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    return [...by.entries()];
  });
  return (
    <>
      <div class="tl-row tl-cmd-head" onClick={() => setOpen(!open())}>
        <div class="body">
          <span class="tl-chev" classList={{ open: open() }}>
            ›
          </span>
          <span class="tl-cmd-count">
            {props.steps.length} command{props.steps.length === 1 ? "" : "s"}
          </span>
          <For each={summary()}>
            {([kind, n]) => (
              <span class="tl-cmd-chip">
                {kind} ×{n}
              </span>
            )}
          </For>
        </div>
      </div>
      <Show when={open()}>
        <For each={props.steps}>{(s) => <CommandRow step={s} />}</For>
      </Show>
    </>
  );
}

function CommandRow(props: { step: TraceStep }) {
  const [open, setOpen] = createSignal(false);
  const more = () => !!props.step.detail;
  return (
    <div class="tl-row tl-cmd-row">
      <div class="body">
        <div
          style={{ display: "flex", "align-items": "center", gap: "8px" }}
          classList={{ "tl-clickable": more() }}
          onClick={() => more() && setOpen(!open())}
        >
          <Show when={props.step.kind}>
            <span class="knd">{props.step.kind}</span>
          </Show>
          <span>{props.step.label}</span>
        </div>
        <Show when={open() && more()}>
          <pre class="tl-detail">{props.step.detail}</pre>
        </Show>
      </div>
    </div>
  );
}

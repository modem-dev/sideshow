import { createMemo, createSignal, For, Show } from "solid-js";
import type { Post, TraceStep } from "./api.ts";
import { Card } from "./Card.tsx";
import { streamLoading, posts, traceSteps } from "./state.ts";

// Treatment E, refined (A → C). A left rail where only anchors get a node —
// user prompts and published posts. Each turn shows just its intent (first
// note) and outcome (last note); everything between — the middle notes AND the
// tool calls, in their real chronological order — folds into one "··· N steps
// ···" toggle. Expanding it reveals the work in order (a note, then the
// commands it triggered, then the next note), not an end-of-turn command dump.
// Steps are the real session trace (synced from the transcript) interleaved
// with posts by time.

interface Gap {
  post: Post | null; // the post this gap leads into; null = trailing
  steps: TraceStep[];
}

function buildGaps(postList: readonly Post[], steps: readonly TraceStep[]): Gap[] {
  const gaps: Gap[] = postList.map((s) => ({ post: s, steps: [] }));
  gaps.push({ post: null, steps: [] });
  const at = (s: Post) => Date.parse(s.createdAt);
  for (const step of steps) {
    const t = step.ts ? Date.parse(step.ts) : NaN;
    let idx = gaps.length - 1; // default: trailing
    if (!Number.isNaN(t)) {
      const found = postList.findIndex((s) => at(s) >= t);
      if (found >= 0) idx = found;
    }
    gaps[idx].steps.push(step);
  }
  return gaps;
}

// A turn: a prompt (or the lead-in before one) and its ordered events — the
// agent's notes and tool calls, kept in sequence so the fold can show them in
// the order they happened.
interface Turn {
  prompt: TraceStep | null;
  events: TraceStep[];
}

function groupTurns(steps: readonly TraceStep[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  const ensure = () => {
    if (!cur) {
      cur = { prompt: null, events: [] };
      turns.push(cur);
    }
    return cur;
  };
  for (const s of steps) {
    if (s.kind === "prompt") {
      cur = { prompt: s, events: [] };
      turns.push(cur);
    } else {
      ensure().events.push(s);
    }
  }
  return turns;
}

export function SessionTimeline() {
  const gaps = createMemo(() => buildGaps(posts, traceSteps()));
  const empty = () => !streamLoading() && posts.length === 0 && traceSteps().length === 0;
  return (
    <div class="timeline">
      <Show when={empty()}>
        <div class="empty">No posts in this session yet.</div>
      </Show>
      <For each={gaps()}>
        {(gap) => (
          <>
            <For each={groupTurns(gap.steps)}>{(turn) => <TurnBlock turn={turn} />}</For>
            <Show when={gap.post}>
              {(s) => (
                <div class="tl-post">
                  <span class="tl-node"></span>
                  <Card post={s()} />
                </div>
              )}
            </Show>
          </>
        )}
      </For>
      <Show when={posts.length > 0 || traceSteps().length > 0}>
        <div class="tl-row tl-tail">
          <div class="body">waiting for feedback…</div>
        </div>
      </Show>
    </div>
  );
}

function TurnBlock(props: { turn: Turn }) {
  const events = () => props.turn.events;
  // first and last note positions; the work between them (and the tool calls)
  // collapse into the fold.
  const sayIdx = createMemo(() =>
    events().reduce<number[]>((acc, e, i) => (e.kind === "say" ? (acc.push(i), acc) : acc), []),
  );
  const intentIdx = () => (sayIdx().length > 0 ? sayIdx()[0] : -1);
  const outcomeIdx = () => (sayIdx().length > 1 ? sayIdx()[sayIdx().length - 1] : -1);
  const middle = createMemo(() =>
    events().filter((_, i) => i !== intentIdx() && i !== outcomeIdx()),
  );
  return (
    <div class="tl-turn">
      <Show when={props.turn.prompt}>{(p) => <TextRow kind="prompt" step={p()} />}</Show>
      <Show when={intentIdx() >= 0}>
        <TextRow kind="response" step={events()[intentIdx()]} />
      </Show>
      <Show when={middle().length > 0}>
        <WorkFold steps={middle()} />
      </Show>
      <Show when={outcomeIdx() >= 0}>
        <TextRow kind="response" step={events()[outcomeIdx()]} />
      </Show>
    </div>
  );
}

// The middle of a turn — notes and tool calls in order — behind one toggle.
// Collapsed it's a quiet "··· N steps ···" line; expanded it lays the steps out
// in sequence (a note, then the commands under it, then the next note).
function WorkFold(props: { steps: TraceStep[] }) {
  const [open, setOpen] = createSignal(false);
  const n = () => props.steps.length;
  const label = () => `${open() ? "Hide" : "Show"} ${n()} work ${n() === 1 ? "step" : "steps"}`;
  const desktopLabel = () => (open() ? `··· hide ${n()} steps ···` : `··· ${n()} steps ···`);
  return (
    <>
      <div class="tl-row tl-notes-fold">
        <button
          type="button"
          class="body tl-clickable tl-fold-button"
          aria-expanded={open()}
          onClick={() => setOpen(!open())}
        >
          <span class="tl-fold-label-desktop">{desktopLabel()}</span>
          <span class="tl-fold-label-mobile">{label()}</span>
          <span class="tl-fold-caret" aria-hidden="true">
            {open() ? "-" : "+"}
          </span>
        </button>
      </div>
      <Show when={open()}>
        <For each={props.steps}>
          {(s) =>
            s.kind === "say" ? <TextRow kind="response" step={s} /> : <CommandRow step={s} />
          }
        </For>
      </Show>
    </>
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

// One tool call inside an expanded fold: a faint mono line (kind + label),
// expanding to its input/result detail.
function CommandRow(props: { step: TraceStep }) {
  const [open, setOpen] = createSignal(false);
  const more = () => !!props.step.detail;
  return (
    <div class="tl-row tl-cmd-row">
      <div class="body">
        <div
          class="tl-cmd-inline"
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

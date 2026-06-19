import { createMemo, For, Show } from "solid-js";
import type { IssueNode, IssueState, IssueTreePart as IssueTreePartData } from "./api.ts";

// issue-tree renders in the trusted viewer origin (not the sandboxed iframe), so
// a raw node.url would run in-origin as an href — allow only safe schemes and
// fall back to plain text otherwise (markdown-it blocks the same schemes). A URL
// with no scheme (relative/anchor) is fine; anything with a scheme we don't
// allowlist (javascript:, data:, vbscript:, …) is dropped.
function safeHref(url?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined;
  return trimmed;
}

// Source → chip (short code + brand color). Unknown sources fall back to the
// first letter on a neutral chip, so a provider we don't know still renders.
const SOURCES: Record<string, { code: string; bg: string }> = {
  github: { code: "GH", bg: "#1f2328" },
  gitlab: { code: "GL", bg: "#fc6d26" },
  linear: { code: "L", bg: "#5e6ad2" },
  jira: { code: "J", bg: "#0052cc" },
  sentry: { code: "S", bg: "#362d59" },
};

function chipFor(source?: string): { code: string; bg: string } {
  const known = source ? SOURCES[source.toLowerCase()] : undefined;
  if (known) return known;
  return { code: (source?.[0] ?? "•").toUpperCase(), bg: "var(--muted)" };
}

// State → status color + label. `done` and `closed` are the terminal states the
// rollup counts as complete. Colors come from viewer chrome tokens (so they flip
// light/dark): green --ok, blue --accent, red --danger, gray --muted/--faint.
const STATES: Record<IssueState, { color: string; label: string }> = {
  open: { color: "var(--ok)", label: "Open" },
  "in-progress": { color: "var(--accent)", label: "In progress" },
  blocked: { color: "var(--danger)", label: "Blocked" },
  done: { color: "var(--muted)", label: "Done" },
  closed: { color: "var(--faint)", label: "Closed" },
};

// Rollup over descendants (the root itself is excluded): total is every node
// beneath the root, done is those in a terminal state. Computed, never stored —
// editing a leaf moves the bar. Matches the "done ÷ total" rule the model card
// describes.
function rollup(root: IssueNode): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const walk = (node: IssueNode) => {
    for (const child of node.children ?? []) {
      total++;
      if (child.state === "done" || child.state === "closed") done++;
      walk(child);
    }
  };
  walk(root);
  return { done, total };
}

function Chip(props: { source?: string; big?: boolean }) {
  const c = () => chipFor(props.source);
  return (
    <span class="itree-chip" classList={{ big: props.big }} style={{ background: c().bg }}>
      {c().code}
    </span>
  );
}

function Status(props: { state: IssueState }) {
  const s = () => STATES[props.state] ?? STATES.open;
  return (
    <span class="itree-status" style={{ color: s().color }}>
      <span class="itree-dot"></span>
      {s().label}
    </span>
  );
}

function Ref(props: { node: IssueNode }) {
  const href = () => safeHref(props.node.url);
  return (
    <Show when={href()} fallback={<span class="itree-ref">{props.node.ref}</span>}>
      <a class="itree-ref" href={href()} target="_blank" rel="noopener noreferrer">
        {props.node.ref}
      </a>
    </Show>
  );
}

// One node row plus, if it has children, the nested rail subtree. The rails and
// elbow connectors are pure CSS (.itree-subtree border + .itree-node::before).
function Node(props: { node: IssueNode }) {
  return (
    <>
      <div class="itree-node">
        <Chip source={props.node.source} />
        <Ref node={props.node} />
        <span class="itree-title">{props.node.title}</span>
        <Show when={props.node.note}>
          <span class="itree-note">{props.node.note}</span>
        </Show>
        <Status state={props.node.state} />
      </div>
      <Show when={props.node.children?.length}>
        <div class="itree-subtree">
          <For each={props.node.children}>{(child) => <Node node={child} />}</For>
        </div>
      </Show>
    </>
  );
}

export function IssueTreePart(props: { part: IssueTreePartData }) {
  const root = () => props.part.root;
  // Memoized so the descendant walk runs once per data change, not on each of the
  // ~4 reactive reads (Show guard, done, total, pct).
  const stats = createMemo(() => rollup(props.part.root));
  const pct = createMemo(() => {
    const { done, total } = stats();
    return total > 0 ? Math.round((done / total) * 100) : 0;
  });
  return (
    <div class="itree">
      <div class="itree-epic">
        <div class="itree-epic-top">
          <Chip source={root().source} big />
          <Ref node={root()} />
          <Status state={root().state} />
        </div>
        <div class="itree-epic-title">{root().title}</div>
        <Show when={stats().total > 0}>
          <div class="itree-prog">
            <span class="itree-lbl">
              {stats().done} / {stats().total} done
            </span>
            <div
              class="itree-bar"
              role="progressbar"
              aria-valuenow={pct()}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${stats().done} of ${stats().total} sub-issues done`}
            >
              <span style={{ width: `${pct()}%` }}></span>
            </div>
            <span class="itree-lbl">{pct()}%</span>
          </div>
        </Show>
      </div>
      <Show when={root().children?.length} fallback={<div class="itree-empty">No sub-issues.</div>}>
        <div class="itree-body">
          <div class="itree-subtree">
            <For each={root().children}>{(child) => <Node node={child} />}</For>
          </div>
        </div>
      </Show>
    </div>
  );
}

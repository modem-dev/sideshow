import { For, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import {
  api,
  relTime,
  type DiffPart as DiffPartData,
  type ImagePart as ImagePartData,
  type MarkdownPart as MarkdownPartData,
  type Surface,
  type TerminalPart as TerminalPartData,
  type TracePart as TracePartData,
} from "./api.ts";
import { DiffPart } from "./DiffPart.tsx";
import { OpenIcon, TrashIcon } from "./icons.tsx";
import { ImagePart } from "./ImagePart.tsx";
import { MarkdownPart } from "./MarkdownPart.tsx";
import { TerminalPart } from "./TerminalPart.tsx";
import { TracePart } from "./TracePart.tsx";
import {
  comments,
  scrollTarget,
  selected,
  sendComment,
  setScrollTarget,
  toast,
  type ViewComment,
} from "./state.ts";

// Card registry keyed by surface id: the "new surface" pill scrolls to the
// card element, and each card tracks its html-part iframes so the postMessage
// bridge in App can resolve the source surface + iframe by contentWindow (a
// surface may have more than one html part, so a card may own several frames).
export const cardEls = new Map<string, { card: HTMLDivElement; iframes: Set<HTMLIFrameElement> }>();

// Resolve which surface + iframe a postMessage came from, by contentWindow.
export function frameForSource(source: unknown): { id: string; iframe: HTMLIFrameElement } | null {
  for (const [id, { iframes }] of cardEls) {
    for (const iframe of iframes) {
      if (iframe.contentWindow === source) return { id, iframe };
    }
  }
  return null;
}

export function Card(props: { surface: Surface }) {
  let card!: HTMLDivElement;
  const iframes = new Set<HTMLIFrameElement>();
  // Absolute part index -> its iframe, for html parts only. Lets the version
  // dropdown rebuild each `/s/:id?part=N` src across every html part.
  const htmlFrames = new Map<number, HTMLIFrameElement>();

  onMount(() => {
    cardEls.set(props.surface.id, { card, iframes });
    onCleanup(() => cardEls.delete(props.surface.id));
    if (scrollTarget() === props.surface.id) {
      setScrollTarget(null);
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  const versionRange = (latest: number) => {
    const out = [];
    for (let v = latest; v >= Math.max(1, latest - props.surface.history.length); v--) out.push(v);
    return out;
  };

  return (
    <div class="card" ref={(el) => (card = el)}>
      <div class="card-head">
        <span class="card-title">{props.surface.title}</span>
        <span class="vslot">
          {/* keyed on version: a new version rebuilds the select, resetting
              the selection to the latest like the live iframe src does */}
          <Show
            when={props.surface.version > 1 && props.surface.version}
            keyed
            fallback={<span class="vbadge">v1</span>}
          >
            {(latest) => (
              <select
                class="vbadge"
                onChange={(e) => {
                  const ver = e.currentTarget.value;
                  const cb = Date.now();
                  for (const [part, frame] of htmlFrames) {
                    frame.src = `/s/${props.surface.id}?part=${part}&ver=${ver}&cb=${cb}`;
                  }
                }}
              >
                <For each={versionRange(latest)}>{(v) => <option value={v}>v{v}</option>}</For>
              </select>
            )}
          </Show>
        </span>
        <span class="card-meta">{relTime(props.surface.updatedAt)}</span>
        <span class="sp"></span>
        <a
          class="act icon open"
          target="_blank"
          href={`/s/${props.surface.id}`}
          title="Open in a new tab"
          aria-label="Open in a new tab"
        >
          <OpenIcon />
        </a>
        <button
          class="act icon del"
          title="Delete surface"
          aria-label={`Delete "${props.surface.title}"`}
          onClick={async () => {
            if (confirm(`Delete "${props.surface.title}"?`)) {
              await api(`/api/surfaces/${props.surface.id}`, { method: "DELETE" });
            }
          }}
        >
          <TrashIcon />
        </button>
      </div>
      {/* Parts render in order, dispatched by kind. Each kind is an explicit
          Match; the fallback is reserved for a kind this viewer build doesn't
          know — which happens when a long-open tab predates a newly added part
          type. It must NOT assume diff (an unknown part is not a broken diff),
          so it shows a neutral refresh hint instead. An html iframe src changes
          only when the version does, so unrelated refetches never reload it. */}
      <Index each={props.surface.parts}>
        {(part, i) => (
          <Switch
            fallback={
              <div class="part-unsupported">
                Can&rsquo;t show this part — refresh sideshow to update the viewer.
              </div>
            }
          >
            <Match when={part().kind === "html"}>
              <iframe
                ref={(el) => {
                  htmlFrames.set(i, el);
                  iframes.add(el);
                  onCleanup(() => {
                    htmlFrames.delete(i);
                    iframes.delete(el);
                  });
                }}
                sandbox="allow-scripts"
                title={
                  props.surface.parts.length > 1
                    ? `${props.surface.title} (part ${i + 1})`
                    : props.surface.title
                }
                src={`/s/${props.surface.id}?part=${i}&ver=${props.surface.version}&cb=${props.surface.version}`}
              ></iframe>
            </Match>
            <Match when={part().kind === "markdown"}>
              <MarkdownPart part={part() as MarkdownPartData} />
            </Match>
            <Match when={part().kind === "diff"}>
              <DiffPart part={part() as DiffPartData} />
            </Match>
            <Match when={part().kind === "image"}>
              <ImagePart part={part() as ImagePartData} />
            </Match>
            <Match when={part().kind === "trace"}>
              <TracePart part={part() as TracePartData} />
            </Match>
            <Match when={part().kind === "terminal"}>
              <TerminalPart part={part() as TerminalPartData} />
            </Match>
          </Switch>
        )}
      </Index>
      <Thread
        surfaceId={props.surface.id}
        placeholder="Reply to the agent…"
        send={(text) =>
          sendComment({ surface: props.surface.id, text, author: "user" }, props.surface.id, text)
        }
      />
    </div>
  );
}

// Comments without a surface (e.g. `sideshow comment` with no --surface)
// live in a session-level thread at the bottom of the stream, which also
// lets the user message the agent without picking a surface.
export function SessionThread() {
  return (
    <div class="card" id="sessionThread">
      <div class="card-head">
        <span class="card-title">Session thread</span>
        <span class="card-meta">not tied to a surface</span>
      </div>
      <Thread
        surfaceId={null}
        placeholder="Message the agent…"
        send={(text) => sendComment({ session: selected(), text, author: "user" }, null, text)}
      />
    </div>
  );
}

function Thread(props: {
  surfaceId: string | null;
  placeholder: string;
  send: (text: string) => Promise<string | null>;
}) {
  const list = () => comments().filter((c) => c.surfaceId === props.surfaceId);
  return (
    <div class="thread">
      <div class="cmts">
        <For each={list()}>{(c) => <CommentRow comment={c} />}</For>
      </div>
      <Composer placeholder={props.placeholder} send={props.send} />
    </div>
  );
}

function CommentRow(props: { comment: ViewComment }) {
  return (
    <div
      class="cmt"
      classList={{ user: props.comment.author === "user", pending: !!props.comment.pending }}
      data-cid={props.comment.id}
    >
      <span class="who">{props.comment.author === "user" ? "you" : props.comment.author}</span>
      <span class="txt">{props.comment.text}</span>
      <span class="when">{relTime(props.comment.createdAt)}</span>
    </div>
  );
}

function Composer(props: { placeholder: string; send: (text: string) => Promise<string | null> }) {
  let input!: HTMLInputElement;
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const error = await props.send(text);
    // on failure the text goes back in the input — never silently lost
    if (error !== null) {
      if (!input.value) input.value = text;
      input.focus();
      toast(`Couldn't send — ${error}. Your message is back in the box.`);
    }
  };
  return (
    <div class="composer">
      <input
        ref={(el) => (input = el)}
        placeholder={props.placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter") send();
        }}
      />
      <button onClick={send}>Send</button>
    </div>
  );
}

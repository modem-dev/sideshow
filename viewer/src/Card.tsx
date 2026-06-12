import { For, onCleanup, onMount, Show } from "solid-js";
import { api, relTime, type Snippet } from "./api.ts";
import {
  comments,
  scrollTarget,
  selected,
  sendComment,
  setScrollTarget,
  toast,
  type ViewComment,
} from "./state.ts";

// Card registry keyed by snippet id: the postMessage bridge in App finds the
// source iframe here, and the "new snippet" pill scrolls to the card element.
export const cardEls = new Map<string, { card: HTMLDivElement; iframe: HTMLIFrameElement }>();

export function Card(props: { snippet: Snippet }) {
  let card!: HTMLDivElement;
  let iframe!: HTMLIFrameElement;

  onMount(() => {
    cardEls.set(props.snippet.id, { card, iframe });
    onCleanup(() => cardEls.delete(props.snippet.id));
    if (scrollTarget() === props.snippet.id) {
      setScrollTarget(null);
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  const versionRange = (latest: number) => {
    const out = [];
    for (let v = latest; v >= Math.max(1, latest - props.snippet.history.length); v--) out.push(v);
    return out;
  };

  return (
    <div class="card" ref={(el) => (card = el)}>
      <div class="card-head">
        <span class="card-title">{props.snippet.title}</span>
        <span class="vslot">
          {/* keyed on version: a new version rebuilds the select, resetting
              the selection to the latest like the live iframe src does */}
          <Show
            when={props.snippet.version > 1 && props.snippet.version}
            keyed
            fallback={<span class="vbadge">v1</span>}
          >
            {(latest) => (
              <select
                class="vbadge"
                onChange={(e) => {
                  iframe.src = `/s/${props.snippet.id}?ver=${e.currentTarget.value}&cb=${Date.now()}`;
                }}
              >
                <For each={versionRange(latest)}>{(v) => <option value={v}>v{v}</option>}</For>
              </select>
            )}
          </Show>
        </span>
        <span class="card-meta">{relTime(props.snippet.updatedAt)}</span>
        <span class="sp"></span>
        <a class="act open" target="_blank" href={`/s/${props.snippet.id}`}>
          open ↗
        </a>
        <button
          class="act del"
          onClick={async () => {
            if (confirm(`Delete "${props.snippet.title}"?`)) {
              await api(`/api/snippets/${props.snippet.id}`, { method: "DELETE" });
            }
          }}
        >
          delete
        </button>
      </div>
      {/* src changes only when the version does, so unrelated refetches never
          reload the sandboxed document */}
      <iframe
        ref={(el) => (iframe = el)}
        sandbox="allow-scripts"
        title={props.snippet.title}
        src={`/s/${props.snippet.id}?cb=${props.snippet.version}`}
      ></iframe>
      <Thread
        snippetId={props.snippet.id}
        placeholder="Reply to the agent…"
        send={(text) =>
          sendComment({ snippet: props.snippet.id, text, author: "user" }, props.snippet.id, text)
        }
      />
    </div>
  );
}

// Comments without a snippet (e.g. `sideshow comment` with no --snippet)
// live in a session-level thread at the bottom of the stream, which also
// lets the user message the agent without picking a snippet.
export function SessionThread() {
  return (
    <div class="card" id="sessionThread">
      <div class="card-head">
        <span class="card-title">Session thread</span>
        <span class="card-meta">not tied to a snippet</span>
      </div>
      <Thread
        snippetId={null}
        placeholder="Message the agent…"
        send={(text) => sendComment({ session: selected(), text, author: "user" }, null, text)}
      />
    </div>
  );
}

function Thread(props: {
  snippetId: string | null;
  placeholder: string;
  send: (text: string) => Promise<string | null>;
}) {
  const list = () => comments().filter((c) => c.snippetId === props.snippetId);
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

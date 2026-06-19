import {
  createSignal,
  For,
  Index,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import {
  api,
  relTime,
  sessionLabel,
  type DiffPart as DiffPartData,
  type ImagePart as ImagePartData,
  type MarkdownPart as MarkdownPartData,
  type MermaidPart as MermaidPartData,
  type Surface,
  type TerminalPart as TerminalPartData,
  type TracePart as TracePartData,
} from "./api.ts";
import { escapeHtml } from "../../server/surfacePage.ts";
import { DiffPart } from "./DiffPart.tsx";
import { CommentIcon, LinkIcon, OpenIcon, TrashIcon } from "./icons.tsx";
import { ImagePart } from "./ImagePart.tsx";
import { MarkdownPart } from "./MarkdownPart.tsx";
import { MermaidPart } from "./MermaidPart.tsx";
import { SandboxedPart } from "./SandboxedPart.tsx";
import { TerminalPart } from "./TerminalPart.tsx";
import { activeTheme } from "./theme.ts";
import { TracePart } from "./TracePart.tsx";
import {
  comments,
  scrollTarget,
  sendComment,
  sessions,
  setScrollTarget,
  toast,
  type ViewComment,
} from "./state.ts";

// Comment text is plain text — it already renders as an escaped text node — but
// it is shown right beside agent-rendered surfaces, so for consistency it goes
// through the same opaque-origin sandbox: the text is escaped to a string here
// and only parsed inside the iframe. `pre-wrap` preserves the author's line
// breaks; the height comes from the resize bridge (a one-liner clamps to ~24px).
const CMT_CSS = `
body {
  margin: 0;
  background: transparent;
  color: var(--text);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
/* pre-wrap lives on the text wrapper, NOT body — otherwise the newlines the
   sandbox template puts around the body would render as blank lines. */
.t { white-space: pre-wrap; word-break: break-word; }
`;

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
                    frame.src = `/s/${props.surface.id}?part=${part}&ver=${ver}&cb=${cb}&theme=${activeTheme()}`;
                  }
                }}
              >
                <For each={versionRange(latest)}>{(v) => <option value={v}>v{v}</option>}</For>
              </select>
            )}
          </Show>
        </span>
        <span class="sp"></span>
        <span class="card-meta">{relTime(props.surface.updatedAt)}</span>
      </div>
      {/* Parts render in order, dispatched by kind. Each kind is an explicit
          Match; the fallback is reserved for a kind this viewer build doesn't
          know — which happens when a long-open tab predates a newly added part
          type. It must NOT assume diff (an unknown part is not a broken diff),
          so it shows a neutral refresh hint instead. An html iframe src changes
          only when the version or the active theme does, so unrelated refetches
          never reload it. */}
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
                src={`/s/${props.surface.id}?part=${i}&ver=${props.surface.version}&cb=${props.surface.version}&theme=${activeTheme()}`}
              ></iframe>
            </Match>
            <Match when={part().kind === "markdown"}>
              <MarkdownPart part={part() as MarkdownPartData} />
            </Match>
            <Match when={part().kind === "mermaid"}>
              <MermaidPart part={part() as MermaidPartData} />
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
        placeholder="Leave a comment…"
        collapsible
        actions={
          <>
            <button
              class="act icon copy"
              title="Copy link to this surface"
              aria-label="Copy link to this surface"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`${location.origin}/s/${props.surface.id}`);
                  toast("Link copied");
                } catch {
                  toast("Couldn't copy the link");
                }
              }}
            >
              <LinkIcon />
            </button>
            <a
              class="act icon open"
              target="_blank"
              href={`/s/${props.surface.id}`}
              title="Open in a new tab"
              aria-label="Open in a new tab"
            >
              <OpenIcon />
            </a>
            <span class="divider"></span>
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
          </>
        }
        send={(text) =>
          sendComment({ surface: props.surface.id, text, author: "user" }, props.surface.id, text)
        }
      />
    </div>
  );
}

function Thread(props: {
  surfaceId: string | null;
  placeholder: string;
  send: (text: string) => Promise<string | null>;
  // When set, the composer is hidden behind a Comment action and the other
  // per-card actions (open/delete/…) share the recessed footer bar. The
  // bar is deliberately darker than the agent surface above it so a user's
  // comment never reads as part of the agent-rendered UI.
  collapsible?: boolean;
  actions?: JSX.Element;
}) {
  const [replying, setReplying] = createSignal(false);
  const list = () => comments().filter((c) => c.surfaceId === props.surfaceId);
  return (
    <div class="thread">
      <Show when={list().length}>
        <div class="cmts">
          <For each={list()}>{(c) => <CommentRow comment={c} />}</For>
        </div>
      </Show>
      <Show
        when={props.collapsible}
        fallback={<Composer placeholder={props.placeholder} send={props.send} />}
      >
        <div class="card-actions">
          <Show
            when={replying()}
            fallback={
              <div class="actbar">
                <button class="act comment" onClick={() => setReplying(true)}>
                  <CommentIcon /> Comment
                </button>
                <span class="sp"></span>
                {props.actions}
              </div>
            }
          >
            <Composer
              placeholder={props.placeholder}
              send={props.send}
              autofocus
              onCancel={() => setReplying(false)}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
}

// The paste block a copied comment puts on the clipboard — enough context
// for an agent to act on the comment when handed it directly.
function pasteBlock(c: ViewComment): string {
  if (c.surfaceId) {
    return `sideshow comment on “${c.surfaceTitle ?? "a surface"}” (surface ${c.surfaceId}):\n“${c.text}”`;
  }
  const s = sessions.find((x) => x.id === c.sessionId);
  return `sideshow comment, session “${s ? sessionLabel(s) : c.sessionId}”:\n“${c.text}”`;
}

function CommentRow(props: { comment: ViewComment }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pasteBlock(props.comment));
      toast("Copied — paste it to your agent");
    } catch {
      toast("Couldn't copy to clipboard");
    }
  };
  const isUser = () => props.comment.author === "user" && !props.comment.pending;
  return (
    <div
      class="cmt"
      classList={{ user: props.comment.author === "user", pending: !!props.comment.pending }}
      data-cid={props.comment.id}
    >
      <span class="who">{props.comment.author === "user" ? "you" : props.comment.author}</span>
      <SandboxedPart
        class="cmtframe"
        body={`<div class="t">${escapeHtml(props.comment.text)}</div>`}
        css={CMT_CSS}
      />
      <Show when={isUser()}>
        <button class="copy" title="Copy for pasting to your agent" onClick={copy}>
          ⧉
        </button>
      </Show>
      <span class="when">{relTime(props.comment.createdAt)}</span>
    </div>
  );
}

function Composer(props: {
  placeholder: string;
  send: (text: string) => Promise<string | null>;
  autofocus?: boolean;
  onCancel?: () => void;
}) {
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
      toast(`Couldn't post that comment — ${error}. It's back in the box.`);
    }
  };
  onMount(() => props.autofocus && input.focus());
  return (
    <div class="composer">
      <input
        ref={(el) => (input = el)}
        placeholder={props.placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter") send();
          // Escape folds the composer back to the action bar — but only when
          // it's empty, so an in-progress reply can't be lost to a stray key.
          else if (e.key === "Escape" && !input.value && props.onCancel) props.onCancel();
        }}
      />
      <button onClick={send}>Comment</button>
      <Show when={props.onCancel}>
        <button class="ghost" onClick={props.onCancel}>
          Cancel
        </button>
      </Show>
    </div>
  );
}

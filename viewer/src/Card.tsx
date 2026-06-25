import {
  createEffect,
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
  appPath,
  canScreenshot,
  isReadonly,
  relTime,
  sessionLabel,
  type ImageSurface as ImagePartData,
  type JsonSurface as JsonPartData,
  type Post,
  type TraceSurface as TracePartData,
  surfaceLink,
  surfaceImageLink,
} from "./api.ts";
import { CommentIcon, ImageIcon, LinkIcon, OpenIcon, TrashIcon } from "./icons.tsx";
import { ImagePart } from "./ImagePart.tsx";
import { JsonPart } from "./JsonPart.tsx";
import { activeTheme, resolvedMode } from "./theme.ts";
import { TracePart } from "./TracePart.tsx";
import {
  comments,
  focusSurface,
  scrollTarget,
  sendComment,
  sessions,
  setScrollTarget,
  toast,
  type ViewComment,
} from "./state.ts";

// Part kinds that become HTML and so render inside a sandboxed iframe served
// from /s/:id — author html plus the server-rendered rich kinds (markdown/code/
// diff/terminal) and the self-rendering mermaid doc. image/trace/json are data
// the viewer renders natively (text nodes / <img> / JSX), never an iframe.
const SANDBOXED_KINDS = new Set(["html", "markdown", "code", "diff", "terminal", "mermaid"]);

// A per-kind class on each part iframe — purely a stable styling/selector hook
// (sizing comes from the bare `iframe` rule); html parts carry none, matching
// the generic `.card iframe` they always used.
const FRAME_CLASS: Record<string, string> = {
  markdown: "mdframe",
  code: "codeframe",
  diff: "diffframe",
  terminal: "termframe",
  mermaid: "mermaidframe",
};

// Card registry keyed by surface id: the "new surface" pill scrolls to the
// card element, and each card tracks its sandboxed-part iframes so the
// postMessage bridge in App can resolve the source surface + iframe by
// contentWindow (a surface may have several sandboxed parts → several frames).
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

// Size a surface iframe from a height the in-frame bridge reported. Min one
// line, max generous enough for a long diff/markdown without runaway growth.
const MIN_FRAME_H = 24;
const MAX_FRAME_H = 4000;
export function applyFrameHeight(iframe: HTMLIFrameElement, reportedHeight: unknown): void {
  iframe.style.height = Math.min(Math.max(Number(reportedHeight), MIN_FRAME_H), MAX_FRAME_H) + "px";
}

// While a deep-link scroll poll is active, IntersectionObserver callbacks on
// other cards must not call focusSurface — they would overwrite the URL with
// whichever card happens to cross the 50% threshold mid-scroll. The poll sets
// this to true and clears it when the position stabilises, at which point it
// calls focusSurface with the correct target surface id.
let deepLinkScrolling = false;

// Repeatedly scroll an element into view until its position stabilises.
// Iframe heights resolve asynchronously (postMessage resize), so a single
// scrollIntoView fires before the layout settles and the target drifts.
// Returns a cancel function so the caller can abort on cleanup.
function pollScrollIntoView(el: HTMLElement, surfaceId: string): () => void {
  // If the card is already near the top of the viewport, no polling needed —
  // skip straight to focusSurface so the app behaves identically to a load
  // without a deep-link target (no IO suppression window, no timers).
  const top = el.getBoundingClientRect().top;
  if (top >= -10 && top <= 200) {
    focusSurface(surfaceId);
    return () => {};
  }

  deepLinkScrolling = true;
  const started = performance.now();
  let lastTop: number | null = null;
  let stableChecks = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = () => {
    deepLinkScrolling = false;
    focusSurface(surfaceId);
  };

  const tick = () => {
    if (stopped) return;
    el.scrollIntoView({ behavior: "instant", block: "start" });
    const top = el.getBoundingClientRect().top;
    if (lastTop !== null && Math.abs(top - lastTop) <= 5) stableChecks += 1;
    else stableChecks = 0;
    lastTop = top;
    // Stable for 3 consecutive checks → done; hard cap at 5 s.
    if (stableChecks >= 3 || performance.now() - started >= 5000) {
      finish();
      return;
    }
    timer = setTimeout(tick, 50);
  };

  tick();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    deepLinkScrolling = false;
  };
}

export function Card(props: { surface: Post; standalone?: boolean }) {
  let card!: HTMLDivElement;
  const iframes = new Set<HTMLIFrameElement>();
  // Absolute part index -> its sandboxed-part iframe. Lets the version dropdown
  // rebuild each `/s/:id?part=N` src across every part that has a frame.
  const partFrames = new Map<number, HTMLIFrameElement>();
  let stopPoll: (() => void) | undefined;

  // React to scrollTarget changes — start the polling scroll when this card
  // becomes the target.  createEffect tracks scrollTarget(); onMount covers
  // the initial render (card ref isn't assigned when the effect first runs).
  const scrollIfTarget = () => {
    if (!card || scrollTarget() !== props.surface.id) return;
    setScrollTarget(null);
    stopPoll?.();
    stopPoll = pollScrollIntoView(card, props.surface.id);
  };

  createEffect(scrollIfTarget);
  onCleanup(() => stopPoll?.());

  onMount(() => {
    cardEls.set(props.surface.id, { card, iframes });
    onCleanup(() => cardEls.delete(props.surface.id));
    // Standalone is a single, full-page surface — there is no feed to scroll
    // through and no session route to track, so skip the deep-link scroll and
    // the URL-syncing observer. The cardEls registration above still runs so the
    // resize bridge can size this surface's part iframes.
    if (props.standalone) return;
    scrollIfTarget();
    // Update the URL as the user scrolls past surfaces (replaceState, no
    // history noise). The first card that crosses the 50% threshold wins.
    const observer = new IntersectionObserver(
      (entries) => {
        if (deepLinkScrolling) return;
        for (const entry of entries) {
          if (entry.isIntersecting) focusSurface(props.surface.id);
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(card);
    onCleanup(() => observer.disconnect());
  });

  const versionRange = (latest: number) => {
    const out = [];
    for (let v = latest; v >= Math.max(1, latest - props.surface.history.length); v--) out.push(v);
    return out;
  };

  return (
    <div class="card" data-id={props.surface.id} ref={(el) => (card = el)}>
      <div class="card-head">
        <span class="card-title">{props.surface.title}</span>
        {/* The version dropdown and "updated" meta are board-feed affordances;
            the standalone page is a clean, single-surface view, so it shows only
            the title (and the watermark its parent adds below). */}
        <Show when={!props.standalone}>
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
                    for (const [part, frame] of partFrames) {
                      frame.src = appPath(
                        `/s/${props.surface.id}?part=${part}&ver=${ver}&cb=${cb}&theme=${activeTheme()}&mode=${resolvedMode()}`,
                      );
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
        </Show>
      </div>
      {/* Parts render in order, dispatched by kind. Each kind is an explicit
          Match; the fallback is reserved for a kind this viewer build doesn't
          know — which happens when a long-open tab predates a newly added part
          type. It must NOT assume diff (an unknown part is not a broken diff),
          so it shows a neutral refresh hint instead. An html iframe src changes
          only when the version, the active theme, or the resolved light/dark
          mode does, so unrelated refetches never reload it. */}
      <Index each={props.surface.surfaces}>
        {(part, i) => (
          <Switch
            fallback={
              <div class="part-unsupported">
                Can&rsquo;t show this part — refresh sideshow to update the viewer.
              </div>
            }
          >
            {/* Every kind that becomes HTML renders the same way: a sandboxed
                iframe pointed at /s/:id?part=N, which the server renders (author
                html, server-rendered markdown/code/diff/terminal, or the
                self-rendering mermaid doc). The src changes only when the
                version, active theme, or resolved light/dark mode does, so
                unrelated refetches never reload it. */}
            <Match when={SANDBOXED_KINDS.has(part().kind)}>
              <iframe
                ref={(el) => {
                  partFrames.set(i, el);
                  iframes.add(el);
                  onCleanup(() => {
                    partFrames.delete(i);
                    iframes.delete(el);
                  });
                }}
                sandbox="allow-scripts"
                class={FRAME_CLASS[part().kind]}
                title={
                  props.surface.surfaces.length > 1
                    ? `${props.surface.title} (part ${i + 1})`
                    : props.surface.title
                }
                src={appPath(
                  `/s/${props.surface.id}?part=${i}&ver=${props.surface.version}&cb=${props.surface.version}&theme=${activeTheme()}&mode=${resolvedMode()}`,
                )}
              ></iframe>
            </Match>
            <Match when={part().kind === "image"}>
              <ImagePart part={part() as ImagePartData} />
            </Match>
            <Match when={part().kind === "trace"}>
              <TracePart part={part() as TracePartData} />
            </Match>
            <Match when={part().kind === "json"}>
              <JsonPart part={part() as JsonPartData} />
            </Match>
          </Switch>
        )}
      </Index>
      <Show when={!props.standalone}>
        <Thread
          surfaceId={props.surface.id}
          placeholder="Leave a comment…"
          collapsible
          readonly={isReadonly()}
          actions={(startReply) => (
            <>
              <Show when={!isReadonly()}>
                <button
                  class="act icon comment"
                  title="Comment"
                  aria-label="Comment"
                  onClick={startReply}
                >
                  <CommentIcon />
                </button>
              </Show>
              <span class="sp"></span>
              <button
                class="act icon copy"
                title="Copy link to this surface"
                aria-label="Copy link to this surface"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(surfaceLink(props.surface.id));
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
                href={surfaceLink(props.surface.id)}
                title="Open in a new tab"
                aria-label="Open in a new tab"
              >
                <OpenIcon />
              </a>
              {/* Open the surface as a PNG. The image is rendered server-side by
                  the Browser Rendering Worker, so the action is only live where
                  that exists; on a plain Node server it's disabled with a tooltip
                  that points at the README. */}
              <Show
                when={canScreenshot()}
                fallback={
                  <button
                    class="act icon shot"
                    disabled
                    title="Saving a surface as an image needs Cloudflare Browser Rendering, which this server doesn't have. See the README."
                    aria-label="Screenshots aren't available on this server"
                  >
                    <ImageIcon />
                  </button>
                }
              >
                <a
                  class="act icon shot"
                  target="_blank"
                  href={surfaceImageLink(props.surface.id)}
                  title="Open as an image (PNG)"
                  aria-label="Open as an image (PNG)"
                >
                  <ImageIcon />
                </a>
              </Show>
              <Show when={!isReadonly()}>
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
              </Show>
            </>
          )}
          send={(text) =>
            sendComment({ surface: props.surface.id, text, author: "user" }, props.surface.id, text)
          }
        />
      </Show>
    </div>
  );
}

function Thread(props: {
  surfaceId: string | null;
  placeholder: string;
  send: (text: string) => Promise<string | null>;
  // When set, the composer is hidden behind a Comment action and the other
  // per-card actions (open/delete/…) share the footer toolbar. The bar sits on
  // the card surface, set off by a hairline divider and muted action styling,
  // so a user's comment never reads as part of the agent-rendered UI.
  collapsible?: boolean;
  readonly?: boolean;
  actions?: (startReply: () => void) => JSX.Element;
}) {
  const [replying, setReplying] = createSignal(false);
  const list = () => comments().filter((c) => c.postId === props.surfaceId);
  return (
    <div class="thread">
      <Show when={list().length}>
        <div class="cmts">
          <For each={list()}>{(c) => <CommentRow comment={c} />}</For>
        </div>
      </Show>
      <Show
        when={props.collapsible}
        fallback={
          <Show when={!props.readonly}>
            <Composer placeholder={props.placeholder} send={props.send} />
          </Show>
        }
      >
        <div class="card-actions">
          <Show
            when={!props.readonly && replying()}
            fallback={<div class="actbar">{props.actions?.(() => setReplying(true))}</div>}
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
  if (c.postId) {
    return `sideshow comment on “${c.postTitle ?? "a surface"}” (surface ${c.postId}):\n“${c.text}”`;
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
      {/* Plain comment text rendered as a Solid text node — escapes by
          construction (the invariant's option-(b) for data), so no iframe is
          needed. `white-space: pre-wrap` (in styles.css) keeps the author's
          line breaks. */}
      <div class="cmt-text">{props.comment.text}</div>
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

import {
  createEffect,
  createSignal,
  For,
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
  type CommentAnchor,
  type ImageSurface as ImageSurfaceData,
  type JsonSurface as JsonSurfaceData,
  type Post,
  type TraceSurface as TraceSurfaceData,
  postLink,
  postImageLink,
} from "./api.ts";
import { isSandboxedSurfaceKind, SURFACE_FRAME_CLASSES } from "../../server/types.ts";
import { CommentIcon, ImageIcon, LinkIcon, OpenIcon, PinIcon, TrashIcon } from "./icons.tsx";
import { ImageSurface } from "./ImageSurface.tsx";
import { JsonSurface } from "./JsonSurface.tsx";
import { activeTheme, resolvedMode } from "./theme.ts";
import { TraceSurface } from "./TraceSurface.tsx";
import {
  comments,
  deleteComment,
  focusPost,
  scrollTarget,
  sendComment,
  sessions,
  setScrollTarget,
  toast,
  type ViewComment,
} from "./state.ts";

// Card registry keyed by post id: the "new post" pill scrolls to the
// card element, and each card tracks its sandboxed-surface iframes so the
// postMessage bridge in App can resolve the source post + iframe by
// contentWindow (a post may have several sandboxed surfaces → several frames).
export const cardEls = new Map<string, { card: HTMLDivElement; iframes: Set<HTMLIFrameElement> }>();

// Resolve which post + iframe a postMessage came from, by contentWindow.
export function frameForSource(source: unknown): { id: string; iframe: HTMLIFrameElement } | null {
  for (const [id, { iframes }] of cardEls) {
    for (const iframe of iframes) {
      if (iframe.contentWindow === source) return { id, iframe };
    }
  }
  return null;
}

// Size a post's surface iframe from a height the in-frame bridge reported. Min
// one line, max generous enough for a long diff/markdown without runaway growth.
const MIN_FRAME_H = 24;
const MAX_FRAME_H = 4000;
export function applyFrameHeight(iframe: HTMLIFrameElement, reportedHeight: unknown): void {
  iframe.style.height = Math.min(Math.max(Number(reportedHeight), MIN_FRAME_H), MAX_FRAME_H) + "px";
}

// While a deep-link scroll poll is active, IntersectionObserver callbacks on
// other cards must not call focusPost — they would overwrite the URL with
// whichever card happens to cross the 50% threshold mid-scroll. The poll sets
// this to true and clears it when the position stabilises, at which point it
// calls focusPost with the correct target post id.
let deepLinkScrolling = false;

// Repeatedly scroll an element into view until its position stabilises.
// Iframe heights resolve asynchronously (postMessage resize), so a single
// scrollIntoView fires before the layout settles and the target drifts.
// Returns a cancel function so the caller can abort on cleanup.
function anchorPoint(anchor: CommentAnchor | undefined): { x: number; y: number } | null {
  if (!anchor || anchor.kind === "lineRange") return null;
  return { x: anchor.x, y: anchor.y };
}

function anchorLabel(anchor: CommentAnchor | undefined): string | null {
  if (!anchor) return null;
  const where = `surface ${anchor.surfaceIndex + 1}`;
  if (anchor.kind === "lineRange") return `${where} · lines ${anchor.startLine}-${anchor.endLine}`;
  return `${where} · v${anchor.postVersion}`;
}

function authorLabel(comment: Pick<ViewComment, "author">): string {
  return comment.author === "user" ? "you" : comment.author;
}

function avatarInitials(author: string): string {
  const label = author === "user" ? "you" : author;
  return (
    label
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function AvatarPin(props: { author: string }) {
  return (
    <span class="avatar-pin" aria-hidden="true">
      <span>{avatarInitials(props.author)}</span>
    </span>
  );
}

function pollScrollIntoView(el: HTMLElement, postId: string): () => void {
  // If the card is already near the top of the viewport, no polling needed —
  // skip straight to focusPost so the app behaves identically to a load
  // without a deep-link target (no IO suppression window, no timers).
  const top = el.getBoundingClientRect().top;
  if (top >= -10 && top <= 200) {
    focusPost(postId);
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
    focusPost(postId);
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

export function Card(props: { post: Post; standalone?: boolean }) {
  let card!: HTMLDivElement;
  const iframes = new Set<HTMLIFrameElement>();
  // Absolute surface index -> its sandboxed-surface iframe. Lets the version
  // dropdown rebuild each `/s/:id?part=N` src across every surface with a frame.
  const surfaceFrames = new Map<number, HTMLIFrameElement>();
  const [annotating, setAnnotating] = createSignal(false);
  const [anchorDraft, setAnchorDraft] = createSignal<CommentAnchor | null>(null);
  let stopPoll: (() => void) | undefined;

  const anchoredComments = (surfaceIndex: number) =>
    comments().filter((c) => c.postId === props.post.id && c.anchor?.surfaceIndex === surfaceIndex);

  const sendPinnedComment = async (text: string) => {
    const anchor = anchorDraft();
    if (!anchor) return "place a pin first";
    const error = await sendComment(
      { surface: props.post.id, text, author: "user", anchor },
      props.post.id,
      text,
    );
    if (error === null) setAnchorDraft(null);
    return error;
  };

  // React to scrollTarget changes — start the polling scroll when this card
  // becomes the target.  createEffect tracks scrollTarget(); onMount covers
  // the initial render (card ref isn't assigned when the effect first runs).
  const scrollIfTarget = () => {
    if (!card || scrollTarget() !== props.post.id) return;
    setScrollTarget(null);
    stopPoll?.();
    stopPoll = pollScrollIntoView(card, props.post.id);
  };

  createEffect(scrollIfTarget);
  onCleanup(() => stopPoll?.());

  onMount(() => {
    cardEls.set(props.post.id, { card, iframes });
    onCleanup(() => cardEls.delete(props.post.id));
    // Standalone is a single, full-page post — there is no feed to scroll
    // through and no session route to track, so skip the deep-link scroll and
    // the URL-syncing observer. The cardEls registration above still runs so the
    // resize bridge can size this post's surface iframes.
    if (props.standalone) return;
    scrollIfTarget();
    // Update the URL as the user scrolls past posts (replaceState, no
    // history noise). The first card that crosses the 50% threshold wins.
    // The observer's first fire reports the card's position at mount: a card
    // already in view (the default/topmost surface when a session opens) is an
    // auto-focus, not a user choice, so it must not write the URL — only an
    // explicit open (a deep link, or scrolling into a surface) does. Discard
    // that initial fire; a card that mounts off-screen fires isIntersecting
    // false first (nothing to write either way), so its first real, user-driven
    // intersecting fire still reflects in the route. A deep-link scroll is
    // already covered by deepLinkScrolling (and writes via pollScrollIntoView),
    // so this only gates the scroll-driven reflection.
    let initialFire = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (deepLinkScrolling) return;
        if (initialFire) {
          initialFire = false;
          return;
        }
        for (const entry of entries) {
          if (entry.isIntersecting) focusPost(props.post.id);
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(card);
    onCleanup(() => observer.disconnect());
  });

  const versionRange = (latest: number) => {
    const out = [];
    for (let v = latest; v >= Math.max(1, latest - props.post.history.length); v--) out.push(v);
    return out;
  };

  return (
    <div class="card" data-id={props.post.id} ref={(el) => (card = el)}>
      <div class="card-head">
        <span class="card-title">{props.post.title}</span>
        {/* The version dropdown and "updated" meta are workspace-feed affordances;
            the standalone page is a clean, single-post view, so it shows only
            the title (and the watermark its parent adds below). */}
        <Show when={!props.standalone}>
          <span class="vslot">
            {/* keyed on version: a new version rebuilds the select, resetting
              the selection to the latest like the live iframe src does */}
            <Show
              when={props.post.version > 1 && props.post.version}
              keyed
              fallback={<span class="vbadge">v1</span>}
            >
              {(latest) => (
                <select
                  class="vbadge"
                  onChange={(e) => {
                    const ver = e.currentTarget.value;
                    const cb = Date.now();
                    for (const [surface, frame] of surfaceFrames) {
                      // `?part=` is the legacy wire query key for a surface index.
                      frame.src = appPath(
                        `/s/${props.post.id}?part=${surface}&ver=${ver}&cb=${cb}&theme=${activeTheme()}&mode=${resolvedMode()}`,
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
          <span class="card-meta">{relTime(props.post.updatedAt)}</span>
        </Show>
      </div>
      {/* Surfaces render in order, dispatched by kind. Each kind is an explicit
          Match; the fallback is reserved for a kind this viewer build doesn't
          know — which happens when a long-open tab predates a newly added
          surface type. It must NOT assume diff (an unknown surface is not a
          broken diff), so it shows a neutral refresh hint instead. An html
          iframe src changes only when the version, the active theme, or the
          resolved light/dark mode does, so unrelated refetches never reload it. */}
      <For each={props.post.surfaces}>
        {(surface, i) => {
          const captureAnchor = (e: MouseEvent) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setAnchorDraft({
              kind: "point",
              surfaceIndex: i(),
              ...(surface.id && { surfaceId: surface.id }),
              surfaceKind: surface.kind,
              postVersion: props.post.version,
              x: Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1),
              y: Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1),
            });
            setAnnotating(false);
          };
          return (
            <div class="surface-shell" classList={{ annotating: annotating() }}>
              <Switch
                fallback={
                  <div class="surface-unsupported">
                    Can&rsquo;t show this surface — refresh sideshow to update the viewer.
                  </div>
                }
              >
                <Match when={isSandboxedSurfaceKind(surface.kind)}>
                  <iframe
                    ref={(el) => {
                      surfaceFrames.set(i(), el);
                      iframes.add(el);
                      onCleanup(() => {
                        surfaceFrames.delete(i());
                        iframes.delete(el);
                      });
                    }}
                    sandbox="allow-scripts"
                    loading="lazy"
                    class={SURFACE_FRAME_CLASSES[surface.kind]}
                    title={
                      props.post.surfaces.length > 1
                        ? `${props.post.title} (surface ${i() + 1})`
                        : props.post.title
                    }
                    src={appPath(
                      `/s/${props.post.id}?part=${i()}&ver=${props.post.version}&cb=${props.post.version}&theme=${activeTheme()}&mode=${resolvedMode()}`,
                    )}
                  ></iframe>
                </Match>
                <Match when={surface.kind === "image"}>
                  <ImageSurface surface={surface as ImageSurfaceData} />
                </Match>
                <Match when={surface.kind === "trace"}>
                  <TraceSurface surface={surface as TraceSurfaceData} />
                </Match>
                <Match when={surface.kind === "json"}>
                  <JsonSurface surface={surface as JsonSurfaceData} />
                </Match>
              </Switch>
              <div class="surface-pins">
                <For each={anchoredComments(i())}>{(c) => <AnchoredComment comment={c} />}</For>
                <Show when={anchorDraft()?.surfaceIndex === i() ? anchorDraft() : null} keyed>
                  {(anchor) => (
                    <AnchoredComposer
                      anchor={anchor}
                      send={sendPinnedComment}
                      onCancel={() => setAnchorDraft(null)}
                    />
                  )}
                </Show>
              </div>
              <Show when={annotating() && !props.standalone && !isReadonly()}>
                <button
                  class="surface-capture"
                  type="button"
                  aria-label="Place a comment on this surface"
                  data-tip="Click to place a comment"
                  onClick={captureAnchor}
                ></button>
              </Show>
            </div>
          );
        }}
      </For>
      <Show when={!props.standalone}>
        <Thread
          postId={props.post.id}
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
                <button
                  class="act icon pin-act"
                  classList={{ active: annotating() }}
                  title="Comment on a spot in a surface"
                  aria-label="Comment on a spot in a surface"
                  onClick={() => {
                    setAnchorDraft(null);
                    setAnnotating((v) => !v);
                  }}
                >
                  <PinIcon />
                </button>
              </Show>
              <span class="sp"></span>
              <button
                class="act icon copy"
                title="Copy link to this post"
                aria-label="Copy link to this post"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(postLink(props.post.id));
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
                rel="noopener"
                href={postLink(props.post.id)}
                title="Open in a new tab"
                aria-label="Open in a new tab"
              >
                <OpenIcon />
              </a>
              {/* Open the first renderable surface as a PNG. The image is
                  rendered server-side by the Browser Rendering Worker, so the
                  action is only live where that exists; on a plain Node server
                  it's disabled with a tooltip that points at the README. */}
              <Show
                when={canScreenshot()}
                fallback={
                  <button
                    class="act icon shot"
                    disabled
                    title="Saving the first surface as an image needs Cloudflare Browser Rendering, which this server doesn't have. See the README."
                    aria-label="Screenshots aren't available on this server"
                  >
                    <ImageIcon />
                  </button>
                }
              >
                <a
                  class="act icon shot"
                  target="_blank"
                  rel="noopener"
                  href={postImageLink(props.post.id)}
                  title="Open first surface as an image (PNG)"
                  aria-label="Open first surface as an image (PNG)"
                >
                  <ImageIcon />
                </a>
              </Show>
              <Show when={!isReadonly()}>
                <span class="divider"></span>
                <button
                  class="act icon del"
                  title="Delete post"
                  aria-label={`Delete "${props.post.title}"`}
                  onClick={async () => {
                    if (confirm(`Delete "${props.post.title}"?`)) {
                      await api(`/api/posts/${props.post.id}`, { method: "DELETE" });
                    }
                  }}
                >
                  <TrashIcon />
                </button>
              </Show>
            </>
          )}
          send={(text) =>
            sendComment({ surface: props.post.id, text, author: "user" }, props.post.id, text)
          }
        />
      </Show>
    </div>
  );
}

function AnchoredComment(props: { comment: ViewComment }) {
  const point = () => anchorPoint(props.comment.anchor);
  return (
    <Show when={point()} keyed>
      {(pt) => (
        <div
          class="anchored-note"
          classList={{ left: pt.x > 0.62, pending: !!props.comment.pending }}
          style={{ left: `${pt.x * 100}%`, top: `${pt.y * 100}%` }}
        >
          <AvatarPin author={props.comment.author} />
          <div class="anchor-card">
            <div class="anchor-head">
              <span class="avatar">{avatarInitials(props.comment.author)}</span>
              <span class="who">{authorLabel(props.comment)}</span>
              <span class="when">{relTime(props.comment.createdAt)}</span>
              <Show when={!isReadonly()}>
                <button
                  class="anchor-del"
                  title="Delete comment"
                  aria-label="Delete pinned comment"
                  onClick={async () => {
                    const error = await deleteComment(props.comment.id);
                    if (error) toast(`Couldn't delete that comment — ${error}`);
                  }}
                >
                  <TrashIcon />
                </button>
              </Show>
            </div>
            <div class="anchor-text">{props.comment.text}</div>
          </div>
        </div>
      )}
    </Show>
  );
}

function AnchoredComposer(props: {
  anchor: CommentAnchor;
  send: (text: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  let input!: HTMLInputElement;
  const point = () => anchorPoint(props.anchor);
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const error = await props.send(text);
    if (error !== null) {
      if (!input.value) input.value = text;
      input.focus();
      toast(`Couldn't post that comment — ${error}. It's back in the box.`);
    }
  };
  onMount(() => input.focus());
  return (
    <Show when={point()} keyed>
      {(pt) => (
        <div
          class="anchored-note composing"
          classList={{ left: pt.x > 0.62 }}
          style={{ left: `${pt.x * 100}%`, top: `${pt.y * 100}%` }}
        >
          <AvatarPin author="user" />
          <div class="anchor-card">
            <div class="anchor-head">
              <span class="avatar">{avatarInitials("user")}</span>
              <span class="who">you</span>
              <span class="anchor-meta">{anchorLabel(props.anchor)}</span>
            </div>
            <div class="anchor-compose">
              <input
                ref={(el) => (input = el)}
                placeholder="Comment on this spot…"
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                  else if (e.key === "Escape" && !input.value) props.onCancel();
                }}
              />
              <button onClick={submit}>Comment</button>
              <button class="ghost" onClick={props.onCancel}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

function Thread(props: {
  postId: string | null;
  placeholder: string;
  send: (text: string) => Promise<string | null>;
  // When set, the composer is hidden behind a Comment action and the other
  // per-card actions (open/delete/…) share the footer toolbar. The bar sits on
  // the card's face, set off by a hairline divider and muted action styling,
  // so a user's comment never reads as part of the agent-rendered UI.
  collapsible?: boolean;
  readonly?: boolean;
  actions?: (startReply: () => void) => JSX.Element;
}) {
  const [replying, setReplying] = createSignal(false);
  const list = () => comments().filter((c) => c.postId === props.postId && !c.anchor);
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
    const anchor = anchorLabel(c.anchor);
    const where = anchor ? ` at ${anchor}` : "";
    return `sideshow comment on “${c.postTitle ?? "a post"}” (post ${c.postId})${where}:\n“${c.text}”`;
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
      <Show when={anchorLabel(props.comment.anchor)} keyed>
        {(label) => <span class="anchor-chip">{label}</span>}
      </Show>
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

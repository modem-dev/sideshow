import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { AgentMark } from "./agentMarks.tsx";
import {
  api,
  appPath,
  initialPageTitle,
  isReadonly,
  layoutMode,
  publicReadMode,
  relTime,
  sessionLabel,
  type Post,
  type SessionRow,
} from "./api.ts";
import { host, isShadow, navHostEl, root, SLOTS } from "./host.ts";
import { applyFrameHeight, Card, cardEls, frameForSource } from "./Card.tsx";
import { ConnectInstructions } from "./Connect.tsx";
import { renderNotes } from "./notes.ts";
import { SessionTimeline } from "./SessionTimeline.tsx";
import { StreamSkeleton } from "./Skeleton.tsx";
import { MoonIcon, PlugIcon, SunIcon, SystemIcon } from "./icons.tsx";
import {
  activeTheme,
  colorModePreference,
  type ColorModePreference,
  initTheme,
  setColorModePreference,
  setTheme,
  themeOptions,
} from "./theme.ts";
import {
  applyRoute,
  bootstrap,
  checkVersion,
  connect,
  dismissUpdate,
  goHome,
  groupSessions,
  initialLoaded,
  live,
  navOpen,
  nearBottom,
  pillTarget,
  refreshSessionsQuiet,
  select,
  selectAdjacent,
  selected,
  sessions,
  setInitialLoaded,
  setNavOpen,
  setPillTarget,
  setUnread,
  setViewMode,
  standalonePost,
  streamLoading,
  posts,
  toast,
  toastShow,
  toastText,
  unread,
  updateNotice,
  viewMode,
} from "./state.ts";

function isConnectPath() {
  const basePath = window.__SIDESHOW_BASE_PATH__ ?? "";
  const rest = location.pathname.startsWith(basePath)
    ? location.pathname.slice(basePath.length)
    : location.pathname;
  return rest === "/connect";
}
const [connectPath, setConnectPath] = createSignal(isConnectPath());

// Stream-only layout: no sidebar, session list, or session chrome — just the
// current session's stream. Driven by the host's `layout` (cloud embed) or the
// self-hosted public-read "session" link (see api.ts `layoutMode`).
const streamMode = () => layoutMode() === "stream";

// The wordmark, doubling as a home link: clicking it clears the current session
// and returns to the empty workspace (goHome). A real <button> so it's keyboard- and
// screen-reader-reachable; it shares the .brand styling with the static header
// and aside wordmarks. This is the guaranteed way back to the workspace when no
// session is selectable in the sidebar — e.g. an embedding host (sideshow cloud)
// showing a full-page view over an empty workspace.
function Brand() {
  return (
    <button
      class="brand"
      type="button"
      aria-label="sideshow — home"
      onClick={() => {
        setConnectPath(false);
        goHome();
      }}
    >
      <span class="livedot" classList={{ on: live() }}></span>sideshow
    </button>
  );
}

function pageTitle(
  post: Post | null,
  session: SessionRow | undefined,
  unreadCount: number,
  serverTitle: string | undefined,
) {
  if (post) return post.title || "sideshow";
  const sessionTitle =
    session && (session.title || session.agent) ? `${sessionLabel(session)} · sideshow` : null;
  const base = sessionTitle || serverTitle || "sideshow";
  return unreadCount > 0 ? `(${unreadCount}) ${base}` : base;
}

export default function App() {
  onMount(() => {
    // Await the initial route resolution (the standalone post fetch, or the
    // first session fetch), then mark the workspace decided and tell the host
    // (onReady). Until then #onboard stays hidden, so neither the empty workspace
    // nor a host's loading overlay flips to real content before we know what to
    // show. .catch keeps it unblocking — a failed fetch still resolves to the
    // (empty) onboarding view, and the host overlay still clears.
    // On a session-scoped publicRead workspace, the SSE connection requires a
    // ?session= param. For standalone post permalinks (/p/:id) the session ID
    // is only discovered during bootstrap (enterStandalone fetches the post).
    // Connecting before that resolves sends /api/events without a session and
    // the server returns 401. Defer the SSE connection until bootstrap finishes
    // so eventsPath() can read the resolved session ID.
    let disconnect: (() => void) | undefined;
    let unmounted = false;
    if (isReadonly() && publicReadMode() === "session") {
      void bootstrap()
        .catch(() => {})
        .finally(() => {
          setInitialLoaded(true);
          host().onReady?.();
          if (!unmounted) disconnect = connect();
        });
    } else {
      void bootstrap()
        .catch(() => {})
        .finally(() => {
          setInitialLoaded(true);
          host().onReady?.();
        });
      disconnect = connect();
    }
    onCleanup(() => {
      unmounted = true;
      disconnect?.();
    });
    checkVersion();
    void initTheme();
    const timer = setInterval(() => {
      if (sessions.length > 0) refreshSessionsQuiet();
    }, 45_000);
    onCleanup(() => clearInterval(timer));
    window.addEventListener("message", onBridgeMessage);
    onCleanup(() => window.removeEventListener("message", onBridgeMessage));
    // returning to the tab counts as seeing the selected session
    const onVisibility = () => {
      const id = selected();
      if (!document.hidden && id) {
        setUnread((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));
    // Cmd+Option+Up/Down jumps between sessions without reaching for the
    // sidebar — Down moves to the next session in the list, Up the previous.
    const onKeydown = (e: KeyboardEvent) => {
      if (streamMode()) return;
      if (!e.metaKey || !e.altKey || e.ctrlKey || e.shiftKey) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        void selectAdjacent(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        void selectAdjacent(-1);
      }
    };
    window.addEventListener("keydown", onKeydown);
    onCleanup(() => window.removeEventListener("keydown", onKeydown));
    // Routing: the host tells us when the route changes (back/forward).
    onCleanup(
      host().router.subscribe((route) => {
        setConnectPath(isConnectPath());
        applyRoute(route);
      }),
    );
  });

  createEffect(() => {
    if (selected()) setConnectPath(false);
  });

  // unseen activity badges the tab title — self-hosted only; an embedding host
  // owns its own document title. The standalone page titles itself after the
  // post instead (set below), so don't fight it here.
  createEffect(() => {
    if (isShadow()) return;
    document.title = pageTitle(
      standalonePost(),
      sessions.find((s) => s.id === selected()),
      unread().size,
      initialPageTitle(),
    );
  });
  // the mobile drawer slides in via a class on the host element (see styles.css
  // `body.nav-open`; self-hosted that element is <body>)
  createEffect(() => navHostEl().classList.toggle("nav-open", navOpen()));

  // sessions bucketed by recency for the sidebar; recomputes whenever the
  // session list changes (incl. the 45s quiet refresh, which keeps the
  // Today/Yesterday split fresh as the day rolls over)
  const sessionGroups = createMemo(() => groupSessions(sessions, new Date()));

  return (
    <Show
      when={standalonePost()}
      keyed
      fallback={
        <>
          <div id="app">
            <header class="topbar">
              <Show when={!streamMode()}>
                <button
                  class="menu"
                  id="menuBtn"
                  aria-label="Show sessions"
                  onClick={() => setNavOpen(!navOpen())}
                >
                  ☰<span class="dot" id="menuDot" classList={{ show: unread().size > 0 }}></span>
                </button>
              </Show>
              {/* A host that supplies its own branding (e.g. cloud) hides the
                  engine wordmark via host.hideBrand. */}
              <Show when={!host().hideBrand}>
                <Brand />
              </Show>
            </header>
            <Show when={!streamMode()}>
              <aside>
                <Show when={!host().hideBrand}>
                  <Brand />
                </Show>
                <UpdateBanner />
                {/* Host-overridable region (SLOTS.asideHead): the sidebar header, above the
                    session list. Empty by default (self-hosted shows nothing here); an embedder
                    projects its own header — e.g. a cloud workspace picker + pinned Home link. */}
                <slot name={SLOTS.asideHead} />
                <div id="sessionList">
                  <For each={sessionGroups()}>
                    {(group) => (
                      <>
                        <div class="sess-group">{group.label}</div>
                        <For each={group.sessions}>{(s) => <SessionItem session={s} />}</For>
                      </>
                    )}
                  </For>
                  {/* Host-overridable region (SLOTS.asideEmpty): the session
                  list's empty state. The fallback below is a native "Connect an
                  agent" row — the first item of an otherwise-empty list — that
                  scrolls to the empty-workspace pane (ss:empty) holding the connect
                  instructions. An embedder projects its own empty-list nudge
                  here; either shows only on a post-load empty workspace, and
                  neither renders once a session exists. */}
                  <Show when={initialLoaded() && sessions.length === 0}>
                    <slot name={SLOTS.asideEmpty}>
                      {/* The native fallback is a connect affordance, so it only
                      makes sense when the workspace is writable — readonly workspaces
                      show "Nothing here yet" in the empty pane, not connect
                      instructions, so the row would point at a contradiction.
                      The slot itself stays mounted so an embedder can still
                      project its own (possibly readonly-appropriate) nudge. */}
                      <Show when={!isReadonly()}>
                        <AsideEmptyRow />
                      </Show>
                    </slot>
                  </Show>
                </div>
                <div class="aside-foot">
                  {/* ThemePicker is a generic feature, not deployment-specific
                  guidance — it stays engine-owned and works under any host. */}
                  <Show when={!isReadonly()}>
                    <ThemePicker />
                  </Show>
                  {/* Host-overridable region (SLOTS.asideFoot): the footer's
                  instructional links/actions. An embedder projects
                  deployment-appropriate ones here; the children below are the
                  self-hosted fallback — shown verbatim when nothing is projected
                  (and outside a shadow root, where <slot> just renders them). */}
                  <slot name={SLOTS.asideFoot}>
                    <a href="/guide" target="_blank">
                      design guide
                    </a>{" "}
                    &nbsp;·&nbsp;{" "}
                    <a href="/setup" target="_blank">
                      agent setup
                    </a>{" "}
                    <Show when={!isReadonly()}>
                      &nbsp;·&nbsp; <a href={appPath("/connect")}>connect agent</a>
                    </Show>
                  </slot>
                </div>
              </aside>
            </Show>
            <main
              onScroll={() => {
                if (nearBottom()) setPillTarget(null);
              }}
            >
              {/* Host-overridable main pane (SLOTS.main). Fallback is the normal
              workspace; an embedder projects a `slot="ss:main"` child to take over the
              pane (e.g. a cloud Settings page) while the sidebar stays. */}
              <slot name={SLOTS.main}>
                <Show
                  when={connectPath()}
                  fallback={
                    <>
                      <Show when={!streamMode()}>
                        <Onboard />
                      </Show>
                      <SessionView />
                    </>
                  }
                >
                  <ConnectPage />
                </Show>
              </slot>
            </main>
          </div>
          <Show when={!streamMode()}>
            <div id="scrim" onClick={() => setNavOpen(false)}></div>
          </Show>
          <div id="toast" role="status" aria-live="polite" classList={{ show: toastShow() }}>
            {toastText()}
          </div>
          <button
            id="newPill"
            hidden={pillTarget() === null}
            onClick={() => {
              const target = pillTarget();
              if (target)
                cardEls.get(target)?.card.scrollIntoView({ behavior: "smooth", block: "start" });
              setPillTarget(null);
            }}
          >
            new post ↓
          </button>
        </>
      }
    >
      {(post) => <StandaloneView post={post} />}
    </Show>
  );
}

// The full-page view a bare /s/:id direct link lands on: just the one post,
// no sidebar/session chrome/comments, with a small sideshow watermark beneath
// it. The Card renders in `standalone` mode (title + surfaces only); its
// iframes are sized by the same postMessage bridge the workspace uses (it resolves
// any registered card, so a standalone card sizes identically).
function StandaloneView(props: { post: Post }) {
  return (
    <div id="standalone">
      <main class="standalone-main">
        <Card post={props.post} standalone />
        <footer class="standalone-foot">
          <a href="https://sideshow.sh" target="_blank" rel="noopener noreferrer">
            made with <strong>sideshow</strong>
          </a>
        </footer>
      </main>
    </div>
  );
}

// Sidebar notice for a newer published release; the matching release notes
// render as a card at the top of the stream (see WhatsNewCard). Dismissing
// either hides both until the next release.
function UpdateBanner() {
  return (
    <Show when={updateNotice()} keyed>
      {(v) => (
        <div class="update-banner" role="status">
          <div class="update-head">
            New version <strong>{v.latest}</strong>
            <button
              class="x"
              aria-label={`Dismiss update notice for ${v.latest}`}
              onClick={() => dismissUpdate(v.latest!)}
            >
              ✕
            </button>
          </div>
          <Show when={v.upgradeCommand}>
            <button
              class="update-cmd"
              title="Copy upgrade command"
              onClick={() => {
                navigator.clipboard.writeText(v.upgradeCommand!);
                toast("Copied: " + v.upgradeCommand);
              }}
            >
              <code>{v.upgradeCommand}</code> ⧉
            </button>
          </Show>
        </div>
      )}
    </Show>
  );
}

// Release notes as a card in the stream — the post already renders cards,
// so "what's new" is just content. Shares dismissal with the banner.
function WhatsNewCard() {
  return (
    <Show when={updateNotice()?.notes ? updateNotice() : null} keyed>
      {(v) => (
        <div class="card" id="whatsNew">
          <div class="card-head">
            <span class="card-title">What&rsquo;s new in {v.latest}</span>
            <span class="card-meta">update available</span>
            <span class="sp"></span>
            <button class="act del" onClick={() => dismissUpdate(v.latest!)}>
              dismiss
            </button>
          </div>
          <div class="update-notes" innerHTML={renderNotes(v.notes!)}></div>
        </div>
      )}
    </Show>
  );
}

// Messages from sandboxed post iframes (see server/surfacePage.ts bridge).
async function onBridgeMessage(ev: MessageEvent) {
  const d = ev.data as {
    __sideshow?: boolean;
    type?: string;
    height?: number;
    text?: unknown;
    url?: string;
    key?: string;
  } | null;
  if (!d || !d.__sideshow) return;
  // Every host-affecting message must come from a frame the viewer actually
  // embedded — never an unexpected/nested frame. send-prompt and resize prove
  // this implicitly (frameForSource resolves the exact html frame); the
  // remaining types reach the host UI directly, so gate them on isOwnFrame.
  // (frameForSource only knows html-surface frames; switch-session is sent only
  // by those, but open-link is sent by rich-surface frames too, so use the
  // broader check that recognizes any embedded iframe.)
  if (d.type === "switch-session") {
    if (!isOwnFrame(ev.source)) return;
    if (streamMode()) return;
    // A post iframe forwarded the session-switch shortcut because focus was
    // inside it (see server/surfacePage.ts). Mirror the parent keydown handler.
    void selectAdjacent(d.key === "ArrowUp" ? -1 : 1);
    return;
  }
  // Resolve the source post + iframe by contentWindow — a post may own
  // several html-surface iframes, so resize must target the exact one.
  const src = frameForSource(ev.source);
  if (d.type === "resize" && src) {
    applyFrameHeight(src.iframe, d.height);
  } else if (d.type === "send-prompt" && src) {
    if (isReadonly()) return;
    // sendPrompt is post-originated: a script inside the sandbox can fire it
    // (or post this message directly) with no user involvement. It must NEVER
    // become an author:"user" comment — that label is reserved for the composer
    // (genuine keystrokes in this trusted origin), so untrusted content rendered
    // in a post can't impersonate the user to the agent. We stamp it
    // author:"surface" (a wire value the server reads): it shows in the post's
    // thread, but the feedback channel only delivers "user" comments, so it
    // never reaches the agent on its own. The user can relay it deliberately.
    await api("/api/comments", {
      method: "POST",
      // `surface` here is the wire body key the server reads (legacy alias).
      body: JSON.stringify({ surface: src.id, text: String(d.text), author: "surface" }),
    });
    toast("Added to this post’s thread");
  } else if (d.type === "open-link" && isOwnFrame(ev.source)) {
    // Only ever open real external links. The in-frame click handler forwards
    // just http(s) hrefs, but a post can call openLink() directly (or post
    // this message raw) with any scheme — javascript:, data:, file: — so
    // re-check host-side, where it can't be bypassed. Parse once and act on the
    // parsed result: validate `protocol` and open the normalized `href` from the
    // same parse, so there's no gap between what we check and what window.open
    // re-parses (and a malformed string is rejected outright).
    let link: URL;
    try {
      link = new URL(String(d.url));
    } catch {
      return;
    }
    if (link.protocol !== "http:" && link.protocol !== "https:") return;
    if (confirm(`Open external link?\n\n${link.href}`))
      window.open(link.href, "_blank", "noopener,noreferrer");
  } else if (d.type === "copy" && isOwnFrame(ev.source)) {
    void navigator.clipboard?.writeText(String(d.text)).catch(() => {});
  }
}

// True when `source` is the contentWindow of an iframe the viewer embedded
// (html or rich surface). frameForSource only tracks html-surface frames; this
// is the broader gate for messages rich-surface frames also send (open-link).
// Identity comparison works across the opaque-origin boundary even though the
// frame's document is unreadable.
function isOwnFrame(source: unknown): boolean {
  for (const f of root().querySelectorAll("iframe")) {
    if (f.contentWindow === source) return true;
  }
  return false;
}

function SessionItem(props: { session: SessionRow }) {
  const label = () => sessionLabel(props.session);
  return (
    <div
      class="sess"
      classList={{
        sel: props.session.id === selected(),
        unread: unread().has(props.session.id),
        vacant: props.session.surfaceCount === 0,
      }}
      data-id={props.session.id}
      role="button"
      tabIndex={0}
      aria-current={props.session.id === selected() ? "true" : undefined}
      onClick={() => {
        setConnectPath(false);
        select(props.session.id);
      }}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          setConnectPath(false);
          select(props.session.id);
        }
      }}
    >
      <div class="sess-title">
        {label()}
        <Show when={props.session.surfaceCount > 0}>
          <span class="sess-count"> ({props.session.surfaceCount})</span>
        </Show>
      </div>
      <div class="sess-meta">
        <AgentMark agent={props.session.agent} />
        {props.session.agent} · {relTime(props.session.lastActiveAt)}
      </div>
      <span class="dot"></span>
      <Show when={!isReadonly()}>
        <button
          class="x"
          title="Delete session"
          aria-label={`Delete session "${label()}"`}
          onClick={async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete "${label()}" and its posts?`)) return;
            await api(`/api/sessions/${props.session.id}`, { method: "DELETE" });
          }}
        >
          ✕
        </button>
      </Show>
    </div>
  );
}

// The native empty-sidebar affordance: the fallback content for the
// ss:aside-empty slot, shown when the workspace has no sessions. It reads as the
// first item of an otherwise-empty list (it reuses the .sess row chrome) — a
// plug icon + "Connect an agent" label, with one line of muted helper text.
// Clicking it scrolls to the empty-workspace pane (#onboard, wrapped by ss:empty)
// that holds the connect instructions; generic, no deployment-specific logic.
function AsideEmptyRow() {
  const activate = () => {
    setNavOpen(false);
    // #onboard is the empty-workspace pane wrapped by ss:empty. When an embedder
    // projects ss:main (taking over the main pane), #onboard isn't in the DOM
    // and this is a silent no-op — acceptable: there's nothing to scroll to.
    root().querySelector("#onboard")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div
      class="sess aside-empty"
      role="button"
      tabIndex={0}
      aria-label="Connect an agent"
      onClick={activate}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          activate();
        }
      }}
    >
      <div class="aside-empty-head">
        <span class="aside-empty-icon">
          <PlugIcon />
        </span>
        <span class="aside-empty-label">Connect an agent</span>
      </div>
      <div class="aside-empty-help">Your sessions will appear here once an agent connects.</div>
    </div>
  );
}

function SessionView() {
  const current = createMemo(() => sessions.find((x) => x.id === selected()));
  return (
    <div id="sessionView" hidden={sessions.length === 0}>
      <div class="session-head">
        <SessionTitle current={current()} />
        <span class="meta" id="sessMeta">
          {current() ? `${current()!.agent} · started ${relTime(current()!.createdAt)}` : ""}
        </span>
        <span class="head-sp"></span>
        <ViewToggle />
        {/* Host-overridable region (SLOTS.sessionActions): session-scoped controls
            an embedder projects beside the toggle (e.g. cloud "Share"). Empty
            fallback — self-hosted renders nothing here. */}
        <slot name={SLOTS.sessionActions}></slot>
      </div>
      <div id="stream">
        <Show
          when={viewMode() === "timeline"}
          fallback={
            <>
              <WhatsNewCard />
              <Show when={streamLoading()}>
                <StreamSkeleton />
              </Show>
              <Show when={!streamLoading() && posts.length === 0}>
                <div class="empty" id="streamEmpty">
                  No posts in this session yet.
                </div>
              </Show>
              <For each={posts}>{(s) => <Card post={s} />}</For>
            </>
          }
        >
          <SessionTimeline />
        </Show>
      </div>
    </div>
  );
}

// Stream ↔ timeline switch in the session head. Timeline is treatment E — the
// session's posts on a center spine with the trace steps between them.
function ViewToggle() {
  return (
    <div class="view-toggle" role="group" aria-label="View mode">
      <button
        classList={{ on: viewMode() === "stream" }}
        aria-pressed={viewMode() === "stream"}
        onClick={() => setViewMode("stream")}
      >
        Stream
      </button>
      <button
        classList={{ on: viewMode() === "timeline" }}
        aria-pressed={viewMode() === "timeline"}
        onClick={() => setViewMode("timeline")}
      >
        Timeline
      </button>
    </div>
  );
}

function SessionTitle(props: { current: SessionRow | undefined }) {
  let el!: HTMLSpanElement;
  // contenteditable owns its text while focused; sync from state otherwise
  createEffect(() => {
    if (props.current && root().activeElement !== el) {
      el.textContent = sessionLabel(props.current);
    }
  });
  const commit = async () => {
    if (isReadonly() || !props.current) return;
    const next = el.textContent?.trim() ?? "";
    if (next && next !== sessionLabel(props.current)) {
      await api(`/api/sessions/${props.current.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: next }),
      });
    }
  };
  return (
    <span
      id="sessTitle"
      ref={(span) => (el = span)}
      contentEditable={!isReadonly()}
      spellcheck={false}
      role="textbox"
      aria-label="Session title"
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          el.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (props.current) el.textContent = sessionLabel(props.current);
          el.blur();
        }
      }}
    ></span>
  );
}

function Onboard() {
  return (
    <div id="onboard" hidden={!initialLoaded() || sessions.length > 0}>
      {/* Host-overridable region (SLOTS.empty): an embedder projects its own
          first-run onboarding here. The fallback below is the self-hosted
          default — setup snippets that assume a local sideshow on port 8228,
          which only make sense self-hosted. The outer #onboard's hidden= still
          governs visibility, so projected content shows only on an empty workspace. */}
      <slot name={SLOTS.empty}>
        <Show
          when={!isReadonly()}
          fallback={
            <>
              <h1>Nothing here yet</h1>
              <p class="sub">This sideshow workspace does not have any sessions yet.</p>
            </>
          }
        >
          <ConnectInstructions
            variant="card"
            title="Connect your first agent"
            subtitle="Sideshow is a live stage where coding agents post HTML — diagrams, sketches, explainers — while they work in your terminal."
            awaiting
          />
        </Show>
      </slot>
    </div>
  );
}

function ConnectPage() {
  return (
    <section class="settings-page connect-page" aria-label="Connect an agent">
      <div class="settings-col">
        <header class="settings-top">
          <h1>Connect an agent</h1>
          <Show
            when={!isReadonly()}
            fallback={<p>This workspace is read-only, so new agents cannot connect from here.</p>}
          >
            <p>
              One command wires sideshow into Claude Code, Cursor, Codex, VS Code, opencode, and
              other MCP-capable agents. New posts show up here automatically.
            </p>
          </Show>
        </header>
        <Show when={!isReadonly()}>
          <section class="settings-sec">
            <h2>MCP setup</h2>
            <ConnectInstructions />
          </section>
        </Show>
      </div>
    </section>
  );
}

// Workspace-level theme selector. Persists via PUT /api/theme; the choice
// re-themes chrome, markdown/diff syntax, and html surfaces together (see
// theme.ts).
function ModeIcon(props: { mode: ColorModePreference }) {
  if (props.mode === "dark") return <MoonIcon />;
  if (props.mode === "light") return <SunIcon />;
  return <SystemIcon />;
}

const COLOR_MODE_LABELS: Record<ColorModePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};
const COLOR_MODE_OPTIONS: ColorModePreference[] = ["system", "light", "dark"];

function ColorModeSwitcher() {
  return (
    <div class="mode-switcher" role="group" aria-label="Color mode">
      <For each={COLOR_MODE_OPTIONS}>
        {(mode) => (
          <button
            type="button"
            classList={{ active: colorModePreference() === mode }}
            aria-label={`${COLOR_MODE_LABELS[mode]} mode`}
            aria-pressed={colorModePreference() === mode}
            title={`${COLOR_MODE_LABELS[mode]} mode`}
            onClick={() => setColorModePreference(mode)}
          >
            <ModeIcon mode={mode} />
          </button>
        )}
      </For>
    </div>
  );
}

function ThemePicker() {
  return (
    <div class="theme-picker">
      <span class="theme-select-wrap">
        <select
          id="themeSel"
          aria-label="Theme"
          value={activeTheme()}
          onChange={(e) => void setTheme(e.currentTarget.value)}
        >
          <For each={themeOptions()}>{(t) => <option value={t.id}>{t.label}</option>}</For>
        </select>
      </span>
      <ColorModeSwitcher />
    </div>
  );
}

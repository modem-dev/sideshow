import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, relTime, sessionLabel, type SessionRow } from "./api.ts";
import { Card, cardEls, frameForSource } from "./Card.tsx";
import { renderNotes } from "./notes.ts";
import { SessionTimeline } from "./SessionTimeline.tsx";
import { activeTheme, initTheme, setTheme, themeOptions } from "./theme.ts";
import {
  checkVersion,
  connect,
  dismissUpdate,
  groupSessions,
  live,
  navOpen,
  nearBottom,
  pillTarget,
  refreshSessions,
  refreshSessionsQuiet,
  select,
  selectAdjacent,
  selected,
  sessions,
  setNavOpen,
  setPillTarget,
  setUnread,
  setViewMode,
  streamLoading,
  surfaces,
  toast,
  toastShow,
  toastText,
  unread,
  updateNotice,
  viewMode,
} from "./state.ts";

// The "Connect Claude Code" integrations modal — module-level so the sidebar
// footer, the onboarding screen, and the overlay can all reach it.
const [connectOpen, setConnectOpen] = createSignal(false);

export default function App() {
  // Escape closes the integrations modal while it is open.
  createEffect(() => {
    if (!connectOpen()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConnectOpen(false);
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  onMount(() => {
    refreshSessions();
    connect();
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
  });

  // unseen activity badges the tab title
  createEffect(() => {
    document.title = unread().size ? `(${unread().size}) sideshow` : "sideshow";
  });
  // the mobile drawer slides in via a body class (see styles.css)
  createEffect(() => document.body.classList.toggle("nav-open", navOpen()));

  // sessions bucketed by recency for the sidebar; recomputes whenever the
  // session list changes (incl. the 45s quiet refresh, which keeps the
  // Today/Yesterday split fresh as the day rolls over)
  const sessionGroups = createMemo(() => groupSessions(sessions, new Date()));

  return (
    <>
      <div id="app">
        <header class="topbar">
          <button
            class="menu"
            id="menuBtn"
            aria-label="Show sessions"
            onClick={() => setNavOpen(!navOpen())}
          >
            ☰<span class="dot" id="menuDot" classList={{ show: unread().size > 0 }}></span>
          </button>
          <div class="brand">
            <span class="livedot" classList={{ on: live() }}></span>sideshow
          </div>
        </header>
        <aside>
          <div class="brand">
            <span class="livedot" classList={{ on: live() }}></span>sideshow
          </div>
          <UpdateBanner />
          <div id="sessionList">
            <For each={sessionGroups()}>
              {(group) => (
                <>
                  <div class="sess-group">{group.label}</div>
                  <For each={group.sessions}>{(s) => <SessionItem session={s} />}</For>
                </>
              )}
            </For>
          </div>
          <div class="aside-foot">
            <ThemePicker />
            <a href="/guide" target="_blank">
              design guide
            </a>{" "}
            &nbsp;·&nbsp;{" "}
            <a href="/setup" target="_blank">
              agent setup
            </a>{" "}
            &nbsp;·&nbsp;{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setConnectOpen(true);
              }}
            >
              connect Claude Code
            </a>
          </div>
        </aside>
        <main
          onScroll={() => {
            if (nearBottom()) setPillTarget(null);
          }}
        >
          <Onboard />
          <SessionView />
        </main>
      </div>
      <div id="scrim" onClick={() => setNavOpen(false)}></div>
      <Show when={connectOpen()}>
        <ConnectModal onClose={() => setConnectOpen(false)} />
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
        new surface ↓
      </button>
    </>
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

// Release notes as a card in the stream — the surface already renders cards,
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

// Messages from sandboxed surface iframes (see server/surfacePage.ts bridge).
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
  // A surface iframe forwarded the session-switch shortcut because focus was
  // inside it (see server/surfacePage.ts). Mirror the parent keydown handler.
  if (d.type === "switch-session") {
    void selectAdjacent(d.key === "ArrowUp" ? -1 : 1);
    return;
  }
  // Resolve the source surface + iframe by contentWindow — a surface may own
  // several html-part iframes, so resize must target the exact one.
  const src = frameForSource(ev.source);
  if (d.type === "resize" && src) {
    src.iframe.style.height = Math.min(Math.max(Number(d.height), 48), 2200) + "px";
  } else if (d.type === "send-prompt" && src) {
    await api("/api/comments", {
      method: "POST",
      body: JSON.stringify({ surface: src.id, text: String(d.text), author: "user" }),
    });
    toast("Sent to agent: " + d.text);
  } else if (d.type === "open-link") {
    if (confirm(`Open external link?\n\n${d.url}`)) window.open(d.url, "_blank", "noopener");
  }
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
      onClick={() => select(props.session.id)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          select(props.session.id);
        }
      }}
    >
      <div class="sess-title">{label()}</div>
      <div class="sess-meta">
        {props.session.agent} ·{" "}
        {props.session.surfaceCount === 0
          ? "no surfaces yet"
          : `${props.session.surfaceCount} surface${props.session.surfaceCount === 1 ? "" : "s"}`}{" "}
        · {relTime(props.session.lastActiveAt)}
      </div>
      <span class="dot"></span>
      <button
        class="x"
        title="Delete session"
        aria-label={`Delete session "${label()}"`}
        onClick={async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete "${label()}" and its surfaces?`)) return;
          await api(`/api/sessions/${props.session.id}`, { method: "DELETE" });
        }}
      >
        ✕
      </button>
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
      </div>
      <div id="stream">
        <Show
          when={viewMode() === "timeline"}
          fallback={
            <>
              <WhatsNewCard />
              <Show when={!streamLoading() && surfaces.length === 0}>
                <div class="empty" id="streamEmpty">
                  No surfaces in this session yet.
                </div>
              </Show>
              <For each={surfaces}>{(s) => <Card surface={s} />}</For>
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
// session's surfaces on a center spine with the trace steps between them.
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
    if (props.current && document.activeElement !== el) {
      el.textContent = sessionLabel(props.current);
    }
  });
  const commit = async () => {
    if (!props.current) return;
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
      contentEditable={true}
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

// withOrigin on the server rewrites these localhost URLs to the deployed
// origin when serving the built document — keep them as plain literals.
const SETUP_SNIP = "curl -s http://localhost:8228/setup >> AGENTS.md";
const TRY_SNIP =
  "curl -s -X POST http://localhost:8228/api/snippets -H 'content-type: application/json' " +
  `-d '{"agent": "me", "title": "Hello", "html": "<h2>It works</h2>"}'`;

function Onboard() {
  return (
    <div id="onboard" hidden={sessions.length > 0}>
      <h1>The show hasn&rsquo;t started yet</h1>
      <p class="sub">
        sideshow is a live surface where coding agents draw HTML snippets — diagrams, sketches,
        explainers — while they work in your terminal.
      </p>
      <h2>teach your agent about it</h2>
      <Snip text={SETUP_SNIP} />
      <h2>or try it yourself</h2>
      <Snip text={TRY_SNIP} />
      <h2>using claude code?</h2>
      <button class="connect-btn" onClick={() => setConnectOpen(true)}>
        Connect Claude Code →
      </button>
    </div>
  );
}

// Install instructions for the Claude Code plugin: a background monitor that
// streams the user's comments to the agent as notifications, plus the sideshow
// MCP server. There is no browser→terminal handoff, so "connect" is two
// copy-paste commands, stated honestly.
const MARKETPLACE_CMD = "/plugin marketplace add modem-dev/sideshow";
const INSTALL_CMD = "/plugin install sideshow@sideshow";

function ConnectModal(props: { onClose: () => void }) {
  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Connect Claude Code"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-head">
          <h2>Connect Claude Code</h2>
          <button class="x" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <p class="sub">
          Install the sideshow plugin so your comments reach the agent on their own. A background
          monitor streams each comment to Claude Code as a notification — no copy-pasting, no
          re-arming a watcher.
        </p>
        <h3>1 · add the marketplace</h3>
        <Snip text={MARKETPLACE_CMD} />
        <h3>2 · install the plugin</h3>
        <Snip text={INSTALL_CMD} />
        <p class="note">
          Run both inside Claude Code. On install it asks for your <strong>Sideshow URL</strong>{" "}
          (default <code>http://localhost:8228</code>, or your deployed instance) and an optional
          token.
        </p>
        <h3>what it runs</h3>
        <p class="note">
          The plugin connects the sideshow MCP server and runs <code>sideshow watch</code> against
          your board as a background process — unsandboxed, the same trust level as hooks, with no
          per-comment prompt. Comments are delivered to the agent exactly once.
        </p>
        <p class="caveat">
          Requires Claude Code ≥ 2.1.105. It&rsquo;s two commands, not a true one-click — Claude
          Code has no browser-to-terminal handoff yet.
        </p>
      </div>
    </div>
  );
}

// Board-level theme selector. Persists via PUT /api/theme; the choice re-themes
// chrome, markdown/diff syntax, and html surface parts together (see theme.ts).
function ThemePicker() {
  return (
    <div class="theme-picker">
      <label for="themeSel">theme</label>
      <select
        id="themeSel"
        value={activeTheme()}
        onChange={(e) => void setTheme(e.currentTarget.value)}
      >
        <For each={themeOptions()}>{(t) => <option value={t.id}>{t.label}</option>}</For>
      </select>
    </div>
  );
}

function Snip(props: { text: string }) {
  const [label, setLabel] = createSignal("copy");
  return (
    <div class="snip">
      {props.text}
      <button
        class="copy"
        onClick={() => {
          navigator.clipboard.writeText(props.text);
          setLabel("copied");
          setTimeout(() => setLabel("copy"), 1500);
        }}
      >
        {label()}
      </button>
    </div>
  );
}

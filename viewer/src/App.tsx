import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, relTime, sessionLabel, type SessionRow } from "./api.ts";
import { Card, cardEls, SessionThread } from "./Card.tsx";
import { renderNotes } from "./notes.ts";
import {
  checkVersion,
  connect,
  dismissUpdate,
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
  snippets,
  streamLoading,
  toast,
  toastShow,
  toastText,
  unread,
  updateNotice,
} from "./state.ts";

export default function App() {
  onMount(() => {
    refreshSessions();
    connect();
    checkVersion();
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
            <For each={sessions}>{(s) => <SessionItem session={s} />}</For>
          </div>
          <div class="aside-foot">
            <a href="/guide" target="_blank">
              design guide
            </a>{" "}
            &nbsp;·&nbsp;{" "}
            <a href="/setup" target="_blank">
              agent setup
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
        new snippet ↓
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

// Messages from sandboxed snippet iframes (see server/snippetPage.ts bridge).
async function onBridgeMessage(ev: MessageEvent) {
  const d = ev.data as {
    __sideshow?: boolean;
    type?: string;
    height?: number;
    text?: unknown;
    url?: string;
  } | null;
  if (!d || !d.__sideshow) return;
  let sourceId: string | null = null;
  let sourceFrame: HTMLIFrameElement | null = null;
  for (const [id, { iframe }] of cardEls) {
    if (iframe.contentWindow === ev.source) {
      sourceId = id;
      sourceFrame = iframe;
      break;
    }
  }
  if (d.type === "resize" && sourceFrame) {
    sourceFrame.style.height = Math.min(Math.max(Number(d.height), 48), 2200) + "px";
  } else if (d.type === "send-prompt" && sourceId) {
    await api("/api/comments", {
      method: "POST",
      body: JSON.stringify({ snippet: sourceId, text: String(d.text), author: "user" }),
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
        {props.session.agent} · {props.session.snippetCount} snippet
        {props.session.snippetCount === 1 ? "" : "s"} · {relTime(props.session.lastActiveAt)}
      </div>
      <span class="dot"></span>
      <button
        class="x"
        title="Delete session"
        aria-label={`Delete session "${label()}"`}
        onClick={async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete "${label()}" and its snippets?`)) return;
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
      </div>
      <div id="stream">
        <WhatsNewCard />
        <Show when={!streamLoading() && snippets.length === 0}>
          <div class="empty" id="streamEmpty">
            No snippets in this session yet.
          </div>
        </Show>
        <For each={snippets}>{(s) => <Card snippet={s} />}</For>
        <SessionThread />
      </div>
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
const SETUP_SNIP = "curl -s http://localhost:4242/setup >> AGENTS.md";
const TRY_SNIP =
  "curl -s -X POST http://localhost:4242/api/snippets -H 'content-type: application/json' " +
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

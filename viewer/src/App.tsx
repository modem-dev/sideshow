import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, relTime, sessionLabel, type SessionRow } from "./api.ts";
import { Card, cardEls, SessionThread } from "./Card.tsx";
import { renderNotes } from "./notes.ts";
import {
  checkVersion,
  colorScheme,
  colorTheme,
  connect,
  dismissUpdate,
  live,
  navOpen,
  nearBottom,
  pillTarget,
  refreshSessions,
  refreshSessionsQuiet,
  resolvedDark,
  select,
  selected,
  sessions,
  setColorScheme,
  setColorTheme,
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

// Swatch order: [field/panel, surface/elevated, accent/ember, text/ink1]
const THEMES: { id: string; label: string; dark: string[]; light: string[] }[] = [
  {
    id: "default",
    label: "Default",
    dark: ["#1f1e1b", "#2a2925", "#85b7eb", "#eceadf"],
    light: ["#faf9f5", "#ffffff", "#185fa5", "#1a1915"],
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    dark: ["#1d2021", "#32302f", "#fe8019", "#ebdbb2"],
    light: ["#ede7d5", "#faf7ec", "#d65d0e", "#3c3836"],
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    dark: ["#11111b", "#1e1e2e", "#cba6f7", "#cdd6f4"],
    light: ["#e6e9ef", "#ffffff", "#8839ef", "#4c4f69"],
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    dark: ["#16161e", "#1f2335", "#7aa2f7", "#c0caf5"],
    light: ["#e1e2e7", "#f7f8fc", "#2e7de9", "#343b58"],
  },
  {
    id: "dracula",
    label: "Dracula",
    dark: ["#21222c", "#343746", "#bd93f9", "#f8f8f2"],
    light: ["#e8e8ee", "#fbfbfd", "#7c3aed", "#16161e"],
  },
  {
    id: "nord",
    label: "Nord",
    dark: ["#272c36", "#3b4252", "#88c0d0", "#eceff4"],
    light: ["#e5e9f0", "#f8f9fb", "#5e81ac", "#2e3440"],
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    dark: ["#191724", "#26233a", "#c4a7e7", "#e0def4"],
    light: ["#f2e9e1", "#fffaf3", "#907aa9", "#575279"],
  },
  {
    id: "everforest",
    label: "Everforest",
    dark: ["#232a2e", "#343f44", "#a7c080", "#d3c6aa"],
    light: ["#f4f0d9", "#fffbef", "#6f8352", "#4d5960"],
  },
  {
    id: "one-dark",
    label: "One Dark",
    dark: ["#21252b", "#2f343e", "#61afef", "#d7dae0"],
    light: ["#eaeaeb", "#ffffff", "#4078f2", "#383a42"],
  },
  {
    id: "monokai",
    label: "Monokai Pro",
    dark: ["#221f22", "#403e41", "#ffd866", "#fcfcfa"],
    light: ["#e9e6e4", "#fcfbfa", "#c08a00", "#2c292d"],
  },
  {
    id: "github",
    label: "GitHub",
    dark: ["#1f2428", "#2b3138", "#58a6ff", "#e1e4e8"],
    light: ["#f0f2f4", "#ffffff", "#0366d6", "#24292e"],
  },
  {
    id: "ayu",
    label: "Ayu",
    dark: ["#0d1017", "#141821", "#e6b450", "#bfbdb6"],
    light: ["#eff1f3", "#fcfcfc", "#f2ae49", "#3d4149"],
  },
  {
    id: "vitesse",
    label: "Vitesse",
    dark: ["#121212", "#1e1e1e", "#4d9375", "#dbd7ca"],
    light: ["#f0f0f0", "#ffffff", "#1c6b48", "#393a34"],
  },
  {
    id: "synthwave",
    label: "Synthwave '84",
    dark: ["#241b2f", "#322a47", "#ff7edb", "#ffffff"],
    light: ["#e6e2f0", "#fbfafd", "#c936a6", "#241b2f"],
  },
];

function ThemePicker() {
  const [open, setOpen] = createSignal(false);
  // oxlint doesn't understand Solid's ref= definite-assignment; suppress false positive
  // eslint-disable-next-line no-unassigned-vars
  let picker!: HTMLDivElement;

  createEffect(() => {
    if (!open()) return;
    const close = (e: MouseEvent) => {
      if (!picker.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", close);
    onCleanup(() => document.removeEventListener("click", close));
  });

  return (
    <div class="theme-picker" ref={picker}>
      <button
        class="theme-pick-btn"
        classList={{ active: colorTheme() !== "default" || colorScheme() !== "auto" }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open());
        }}
        title="Theme"
        aria-label="Theme settings"
        aria-expanded={open()}
      >
        ◑
      </button>
      <Show when={open()}>
        <div class="theme-popover" role="dialog" aria-label="Theme settings">
          <div class="theme-pop-section">
            <div class="theme-pop-label">Mode</div>
            <div class="theme-seg">
              <button
                classList={{ on: colorScheme() === "light" }}
                onClick={() => setColorScheme("light")}
              >
                ☼ Light
              </button>
              <button
                classList={{ on: colorScheme() === "auto" }}
                onClick={() => setColorScheme("auto")}
              >
                Auto
              </button>
              <button
                classList={{ on: colorScheme() === "dark" }}
                onClick={() => setColorScheme("dark")}
              >
                ☾ Dark
              </button>
            </div>
          </div>
          <div class="theme-pop-section">
            <div class="theme-pop-label">Theme</div>
            <div class="theme-card-grid">
              <For each={THEMES}>
                {(t) => (
                  <button
                    class="theme-card"
                    classList={{ on: colorTheme() === t.id }}
                    onClick={() => setColorTheme(t.id)}
                  >
                    <span class="swatches">
                      <For each={resolvedDark() ? t.dark : t.light}>
                        {(c) => <span class="swatch" style={{ background: c }} />}
                      </For>
                    </span>
                    <span class="theme-card-label">{t.label}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </div>
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
        <ThemePicker />
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

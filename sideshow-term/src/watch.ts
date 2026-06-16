// The live viewer — a long-running TUI the user keeps open in a spare
// terminal. It connects to a sideshow server, lists published snippets in a
// sidebar, and renders the selected snippet's STML in a scrollable pane.
// Server-Sent Events keep it live: a new or revised snippet appears at once.
// Bun only (opentui native core).
//
// This is the terminal analogue of "keep the browser tab open". Feedback
// (commenting back) is deferred to a later version; this is render-only.

import {
  BoxRenderable,
  createCliRenderer,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import { buildDocument } from "./render.ts";
import { resolveColor } from "./theme.ts";

const BASE = (process.env.SIDESHOW_URL ?? "http://localhost:4243").replace(/\/$/, "");
const TOKEN = process.env.SIDESHOW_TOKEN;
const authHeaders: Record<string, string> = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

interface SnippetMeta {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
}
interface SessionRow {
  id: string;
  title: string | null;
  agent: string;
  snippets: SnippetMeta[];
}

const muted = resolveColor("muted") ?? undefined;
const heading = resolveColor("heading") ?? undefined;

async function api<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: authHeaders });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function main() {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30, useMouse: true });

  // --- static layout ---
  const rootCol = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  renderer.root.add(rootCol);

  const header = new TextRenderable(renderer, { content: "", paddingLeft: 1, height: 1 });
  rootCol.add(header);

  const body = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, width: "100%" });
  rootCol.add(body);

  const sidebar = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: 30,
    border: true,
    borderStyle: "single",
    borderColor: muted,
    title: "snippets",
    paddingLeft: 1,
  });
  body.add(sidebar);

  const main = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    paddingLeft: 1,
    paddingRight: 1,
  });
  body.add(main);

  const mainHeader = new TextRenderable(renderer, { content: "", height: 1 });
  main.add(mainHeader);

  const scroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    rootOptions: { flexGrow: 1 },
  });
  main.add(scroll);

  const footer = new TextRenderable(renderer, {
    content: "↑/↓ select   click sidebar   [ / ] scroll   wheel scroll   r refresh   q quit",
    paddingLeft: 1,
    height: 1,
    fg: muted,
  });
  rootCol.add(footer);

  // --- state ---
  let sessions: SessionRow[] = [];
  let flat: SnippetMeta[] = []; // navigable snippets, in sidebar order
  let selectedId: string | null = null;

  function selectedIndex(): number {
    return flat.findIndex((s) => s.id === selectedId);
  }

  async function refreshData(preferId?: string) {
    const list =
      await api<Array<{ id: string; title: string | null; agent: string }>>("/api/sessions");
    if (!list) return;
    const rows: SessionRow[] = [];
    for (const s of list) {
      const snips = (await api<SnippetMeta[]>(`/api/sessions/${s.id}/snippets`)) ?? [];
      rows.push({ id: s.id, title: s.title, agent: s.agent, snippets: snips });
    }
    sessions = rows;
    flat = rows.flatMap((r) => r.snippets);
    if (preferId && flat.some((s) => s.id === preferId)) selectedId = preferId;
    if (!selectedId || !flat.some((s) => s.id === selectedId)) {
      selectedId = flat.length > 0 ? flat[flat.length - 1].id : null;
    }
    renderSidebar();
    await showSelected();
    header.content = `sideshow-term  ·  ${BASE}  ·  ${flat.length} snippet${flat.length === 1 ? "" : "s"}`;
  }

  function clearChildren(node: BoxRenderable) {
    // copy first: remove() mutates the live children array we're iterating
    for (const child of node.getChildren().slice()) node.remove(child.id);
  }

  function selectSnippet(id: string) {
    selectedId = id;
    renderSidebar();
    void showSelected();
  }

  function renderSidebar() {
    clearChildren(sidebar);
    if (flat.length === 0) {
      sidebar.add(new TextRenderable(renderer, { content: "No snippets yet.", fg: muted }));
      sidebar.add(new TextRenderable(renderer, { content: "Waiting for an agent…", fg: muted }));
      return;
    }
    for (const session of sessions) {
      if (session.snippets.length === 0) continue;
      sidebar.add(
        new TextRenderable(renderer, { content: session.title ?? session.agent, fg: muted }),
      );
      for (const snip of session.snippets) {
        const selected = snip.id === selectedId;
        const label = `${selected ? "› " : "  "}${snip.title}`;
        sidebar.add(
          new TextRenderable(renderer, {
            content: label,
            fg: selected ? heading : undefined,
            bg: selected ? (resolveColor("subtle") ?? undefined) : undefined,
            height: 1,
            width: "100%",
            selectable: false,
            onMouseUp(event) {
              if (event.button !== 0) return;
              event.stopPropagation();
              selectSnippet(snip.id);
            },
          }),
        );
      }
    }
  }

  async function showSelected() {
    clearChildren(scroll.content as unknown as BoxRenderable);
    scroll.scrollTop = 0;
    if (!selectedId) {
      mainHeader.content = "";
      scroll.content.add(
        new TextRenderable(renderer, {
          content: "Nothing published yet. Publish a snippet to see it here.",
          fg: muted,
        }),
      );
      return;
    }
    const snippet = await api<{ id: string; title: string; html: string; version: number }>(
      `/api/snippets/${selectedId}`,
    );
    if (!snippet) return;
    mainHeader.content = `${snippet.title}  ·  v${snippet.version}`;
    const { root, errors } = buildDocument(renderer, snippet.html);
    scroll.content.add(root);
    if (errors.length > 0) {
      scroll.content.add(
        new TextRenderable(renderer, {
          content: `⚠ ${errors.length} render note(s): ${errors.join("; ")}`,
          fg: resolveColor("warning") ?? undefined,
          marginTop: 1,
        }),
      );
    }
  }

  function move(delta: number) {
    if (flat.length === 0) return;
    const cur = selectedIndex();
    const next = Math.max(0, Math.min(flat.length - 1, (cur < 0 ? 0 : cur) + delta));
    selectSnippet(flat[next].id);
  }

  renderer.keyInput.on("keypress", (key) => {
    switch (key.name) {
      case "q":
        renderer.destroy();
        process.exit(0);
        break;
      case "up":
      case "k":
        move(-1);
        break;
      case "down":
      case "j":
        move(1);
        break;
      case "[":
      case "pageup":
        scroll.scrollBy(-8);
        break;
      case "]":
      case "pagedown":
      case "space":
        scroll.scrollBy(8);
        break;
      case "r":
        void refreshData();
        break;
    }
  });

  await refreshData();

  // --- live updates over SSE ---
  void subscribe(async (event) => {
    if (event.type === "snippet-created") {
      await refreshData(event.id as string);
    } else if (
      event.type === "snippet-updated" ||
      event.type === "snippet-deleted" ||
      String(event.type).startsWith("session-")
    ) {
      if (event.type === "snippet-updated" && event.id === selectedId) {
        await refreshData();
      } else {
        await refreshData(selectedId ?? undefined);
      }
    }
  });
}

// Minimal SSE client over fetch — reconnects on drop. Avoids depending on a
// global EventSource so this behaves identically on any Bun version.
async function subscribe(onEvent: (event: Record<string, unknown>) => void) {
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/events`, {
        headers: { ...authHeaders, accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "{}") continue;
            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              if (parsed.type) onEvent(parsed);
            } catch {
              // ignore malformed frame
            }
          }
        }
      }
    } catch {
      // server restart or transient drop — pause then reconnect
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

main();

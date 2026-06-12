// Shared state and the flows that mutate it. Stores reconcile by id so DOM
// rows/cards persist across refetches (focus, composer drafts, iframes).
import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { api, type Comment, type SessionRow, type Snippet } from "./api.ts";

// A comment as the viewer renders it: server comments plus the optimistic
// local echo (pending until the POST confirms).
export type ViewComment = Comment & { pending?: boolean };

export const [sessions, setSessions] = createStore<SessionRow[]>([]);
export const [selected, setSelected] = createSignal<string | null>(null);
export const [unread, setUnread] = createSignal<ReadonlySet<string>>(new Set<string>());
export const [snippets, setSnippets] = createStore<Snippet[]>([]);
export const [comments, setComments] = createSignal<ViewComment[]>([]);
export const [streamLoading, setStreamLoading] = createSignal(false);
export const [live, setLive] = createSignal(false);
export const [navOpen, setNavOpen] = createSignal(false);
// Snippet id the next mounted card should scroll to (set for SSE arrivals
// landing while the user is near the bottom, not the initial batch of a
// session switch).
export const [scrollTarget, setScrollTarget] = createSignal<string | null>(null);
// Snippet id the "new snippet ↓" pill jumps to — set instead of scrolling
// when the user is reading further up.
export const [pillTarget, setPillTarget] = createSignal<string | null>(null);

export const [toastText, setToastText] = createSignal("");
export const [toastShow, setToastShow] = createSignal(false);
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string) {
  setToastText(text);
  setToastShow(true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToastShow(false), 4000);
}

function markUnread(sessionId: string) {
  setUnread((prev) => new Set(prev).add(sessionId));
}

export async function refreshSessionsQuiet() {
  setSessions(reconcile(await api<SessionRow[]>("/api/sessions"), { key: "id" }));
}

export async function refreshSessions() {
  await refreshSessionsQuiet();
  if (selected() && !sessions.some((s) => s.id === selected())) setSelected(null);
  if (!selected() && sessions.length > 0) await select(sessions[0].id);
}

export async function select(id: string) {
  setSelected(id);
  setUnread((prev) => {
    const next = new Set(prev);
    next.delete(id);
    return next;
  });
  setPillTarget(null);
  setNavOpen(false);
  setStreamLoading(true);
  setSnippets(reconcile([]));
  setComments([]);
  const metas = await api<{ id: string }[]>(`/api/sessions/${id}/snippets`).catch(() => []);
  const details = (
    await Promise.all(metas.map((m) => api<Snippet>(`/api/snippets/${m.id}`).catch(() => null)))
  ).filter((s) => s !== null);
  if (selected() !== id) return; // user switched away mid-load
  setSnippets(reconcile(details, { key: "id" }));
  setStreamLoading(false);
  const res = await api<{ comments: Comment[] }>(`/api/comments?session=${id}`).catch(() => null);
  if (!res || selected() !== id) return;
  mergeComments(res.comments);
}

// Fetch a snippet and insert/update it in the open session's stream.
export async function upsertSnippet(id: string, { scroll = true } = {}) {
  const s = await api<Snippet>(`/api/snippets/${id}`).catch(() => null);
  if (!s || s.sessionId !== selected()) return;
  const idx = snippets.findIndex((x) => x.id === s.id);
  if (idx >= 0) {
    setSnippets(idx, reconcile(s));
  } else {
    // Follow new snippets only when the user is already at the bottom;
    // never yank them away from whatever they're reading mid-scroll.
    if (scroll) {
      if (nearBottom()) setScrollTarget(s.id);
      else setPillTarget(s.id);
    }
    setSnippets(snippets.length, s);
  }
}

export function nearBottom() {
  const m = document.querySelector("main");
  return !!m && m.scrollHeight - m.scrollTop - m.clientHeight < 200;
}

export function mergeComments(list: Comment[]) {
  setComments((prev) => {
    const seen = new Set(prev.map((c) => c.id));
    const fresh = list.filter((c) => !seen.has(c.id));
    return fresh.length > 0 ? [...prev, ...fresh] : prev;
  });
}

let localSeq = 0;

// Echo the comment immediately (pending until the POST confirms), and on
// failure report the error so the composer can put the text back — a user
// message must never be silently lost. Returns the error message, or null.
export async function sendComment(
  body: Record<string, unknown>,
  snippetId: string | null,
  text: string,
): Promise<string | null> {
  const local: ViewComment = {
    id: `local-${++localSeq}`,
    seq: 0,
    sessionId: selected() ?? "",
    snippetId,
    snippetTitle: null,
    author: "user",
    text,
    createdAt: new Date().toISOString(),
    pending: true,
  };
  setComments((prev) => [...prev, local]);
  try {
    const created = await api<Comment>("/api/comments", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setComments((prev) => {
      // the SSE refetch may have rendered it already; keep one copy
      if (prev.some((c) => c.id === created.id)) return prev.filter((c) => c.id !== local.id);
      return prev.map((c) => (c.id === local.id ? created : c));
    });
    return null;
  } catch (err) {
    setComments((prev) => prev.filter((c) => c.id !== local.id));
    return err instanceof Error && err.message ? err.message : "network error";
  }
}

interface FeedEvent {
  type: string;
  id: string;
  sessionId?: string;
  snippetId?: string | null;
}

export function connect() {
  const es = new EventSource("/api/events");
  let everConnected = false;
  es.onopen = async () => {
    setLive(true);
    // events that fired during a gap are gone for good — refetch so the
    // board can't silently go stale while still looking live
    if (everConnected) await resyncSelected();
    everConnected = true;
  };
  es.onerror = () => setLive(false);
  es.onmessage = async (ev) => {
    const e = JSON.parse(ev.data) as FeedEvent;
    // activity the user isn't looking at — other session or hidden tab —
    // marks the session unread, which also badges the tab title
    const away = e.sessionId != null && (e.sessionId !== selected() || document.hidden);
    if (e.type.startsWith("session-")) {
      await refreshSessions();
    } else if (e.type === "snippet-created" || e.type === "snippet-updated") {
      if (away && e.sessionId) markUnread(e.sessionId);
      if (e.sessionId === selected()) await upsertSnippet(e.id);
      await refreshSessionsQuiet();
    } else if (e.type === "snippet-deleted") {
      const idx = snippets.findIndex((s) => s.id === e.id);
      if (idx >= 0) setSnippets(produce((arr) => arr.splice(idx, 1)));
      await refreshSessionsQuiet();
    } else if (e.type === "comment-created") {
      if (away && e.sessionId) markUnread(e.sessionId);
      if (e.sessionId === selected()) {
        const query = e.snippetId ? `snippet=${e.snippetId}` : `session=${e.sessionId}`;
        const res = await api<{ comments: Comment[] }>(`/api/comments?${query}`);
        mergeComments(res.comments);
      }
    }
  };
}

// Re-fetch the selected session's snippets and comments after an SSE
// reconnect; snippets reconcile by id and comments dedupe by id.
async function resyncSelected() {
  const before = selected();
  await refreshSessions();
  if (!before || selected() !== before) return; // select() rebuilt the stream
  const metas = await api<{ id: string }[]>(`/api/sessions/${before}/snippets`).catch(() => []);
  const ids = new Set(metas.map((m) => m.id));
  setSnippets(
    produce((arr) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (!ids.has(arr[i].id)) arr.splice(i, 1);
      }
    }),
  );
  for (const meta of metas) await upsertSnippet(meta.id, { scroll: false });
  const res = await api<{ comments: Comment[] }>(`/api/comments?session=${before}`).catch(
    () => null,
  );
  if (res && selected() === before) mergeComments(res.comments);
}

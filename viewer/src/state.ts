// Shared state and the flows that mutate it. Stores reconcile by id so DOM
// rows/cards persist across refetches (focus, composer drafts, iframes).
import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { api, type Comment, type SessionRow, type Snippet } from "./api.ts";

export const [sessions, setSessions] = createStore<SessionRow[]>([]);
export const [selected, setSelected] = createSignal<string | null>(null);
export const [unread, setUnread] = createSignal<ReadonlySet<string>>(new Set<string>());
export const [snippets, setSnippets] = createStore<Snippet[]>([]);
export const [comments, setComments] = createSignal<Comment[]>([]);
export const [streamLoading, setStreamLoading] = createSignal(false);
export const [live, setLive] = createSignal(false);
// Snippet id the next mounted card should scroll to (set for SSE arrivals,
// not the initial batch of a session switch).
export const [scrollTarget, setScrollTarget] = createSignal<string | null>(null);

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
    if (scroll) setScrollTarget(s.id);
    setSnippets(snippets.length, s);
  }
}

export function mergeComments(list: Comment[]) {
  setComments((prev) => {
    const seen = new Set(prev.map((c) => c.id));
    const fresh = list.filter((c) => !seen.has(c.id));
    return fresh.length > 0 ? [...prev, ...fresh] : prev;
  });
}

interface FeedEvent {
  type: string;
  id: string;
  sessionId: string;
  snippetId?: string | null;
}

export function connect() {
  const es = new EventSource("/api/events");
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false);
  es.onmessage = async (ev) => {
    const e = JSON.parse(ev.data) as FeedEvent;
    if (e.type.startsWith("session-")) {
      await refreshSessions();
    } else if (e.type === "snippet-created" || e.type === "snippet-updated") {
      if (e.sessionId === selected()) await upsertSnippet(e.id);
      else markUnread(e.sessionId);
      await refreshSessionsQuiet();
    } else if (e.type === "snippet-deleted") {
      const idx = snippets.findIndex((s) => s.id === e.id);
      if (idx >= 0) setSnippets(produce((arr) => arr.splice(idx, 1)));
      await refreshSessionsQuiet();
    } else if (e.type === "comment-created") {
      if (e.sessionId === selected()) {
        const query = e.snippetId ? `snippet=${e.snippetId}` : `session=${e.sessionId}`;
        const res = await api<{ comments: Comment[] }>(`/api/comments?${query}`);
        mergeComments(res.comments);
      } else {
        markUnread(e.sessionId);
      }
    }
  };
}

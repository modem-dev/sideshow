// Shared state and the flows that mutate it. Stores reconcile by id so DOM
// rows/cards persist across refetches (focus, composer drafts, iframes).
import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { api, type Comment, type SessionRow, type Surface, type VersionInfo } from "./api.ts";
import { applyTheme } from "./theme.ts";

// A comment as the viewer renders it: server comments plus the optimistic
// local echo (pending until the POST confirms).
export type ViewComment = Comment & { pending?: boolean };

const [sessionsStore, setSessionsInternal] = createStore<SessionRow[]>([]);
export const sessions = sessionsStore;

export interface SessionGroup {
  label: string;
  sessions: SessionRow[];
}

// Bucket sessions by last-active recency (Today / Yesterday / Earlier) so the
// freshest work stays on top and a long history reads at a glance. Within a
// bucket, sessions with no surfaces yet sink to the bottom (and render dimmed)
// — present but out of the way. Empty buckets are omitted. `now` is injectable
// for tests; callers pass the real clock.
export function groupSessions(list: readonly SessionRow[], now: Date): SessionGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const buckets: SessionGroup[] = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "Earlier", sessions: [] },
  ];
  for (const s of list) {
    const t = Date.parse(s.lastActiveAt);
    const bucket = t >= startOfToday ? buckets[0] : t >= startOfYesterday ? buckets[1] : buckets[2];
    bucket.sessions.push(s);
  }
  for (const b of buckets) {
    b.sessions.sort((a, c) => {
      const ae = a.surfaceCount === 0;
      const ce = c.surfaceCount === 0;
      if (ae !== ce) return ae ? 1 : -1; // empties last
      return c.lastActiveAt.localeCompare(a.lastActiveAt); // newest first
    });
  }
  return buckets.filter((b) => b.sessions.length > 0);
}
const [selectedState, setSelectedInternal] = createSignal<string | null>(null);
export const selected = selectedState;
export const [unread, setUnread] = createSignal<ReadonlySet<string>>(new Set<string>());
const [surfacesStore, setSurfacesInternal] = createStore<Surface[]>([]);
export const surfaces = surfacesStore;
const [commentsState, setCommentsInternal] = createSignal<ViewComment[]>([]);
export const comments = commentsState;
const [streamLoadingState, setStreamLoadingInternal] = createSignal(false);
export const streamLoading = streamLoadingState;
const [liveState, setLiveInternal] = createSignal(false);
export const live = liveState;
export const [navOpen, setNavOpen] = createSignal(false);
// Surface id the next mounted card should scroll to (set for SSE arrivals
// landing while the user is near the bottom, not the initial batch of a
// session switch).
export const [scrollTarget, setScrollTarget] = createSignal<string | null>(null);
// Surface id the "new surface ↓" pill jumps to — set instead of scrolling
// when the user is reading further up.
export const [pillTarget, setPillTarget] = createSignal<string | null>(null);

const [toastTextState, setToastTextInternal] = createSignal("");
export const toastText = toastTextState;
const [toastShowState, setToastShowInternal] = createSignal(false);
export const toastShow = toastShowState;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string) {
  setToastTextInternal(text);
  setToastShowInternal(true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToastShowInternal(false), 4000);
}

function markUnread(sessionId: string) {
  setUnread((prev) => new Set(prev).add(sessionId));
}

// Update notice: shown when the server reports a newer release the user has
// not dismissed. Dismissal stores the version, not a flag, so dismissing
// 0.4.0 keeps it gone until 0.5.0 actually ships.
const DISMISSED_UPDATE_KEY = "sideshow-dismissed-update";
const [versionInfo, setVersionInfo] = createSignal<VersionInfo | null>(null);
const [dismissedUpdate, setDismissedUpdate] = createSignal(
  localStorage.getItem(DISMISSED_UPDATE_KEY),
);

export async function checkVersion() {
  setVersionInfo(await api<VersionInfo>("/api/version").catch(() => null));
}

export function dismissUpdate(version: string) {
  localStorage.setItem(DISMISSED_UPDATE_KEY, version);
  setDismissedUpdate(version);
}

export function updateNotice(): VersionInfo | null {
  const v = versionInfo();
  return v?.updateAvailable && v.latest && v.latest !== dismissedUpdate() ? v : null;
}

export async function refreshSessionsQuiet() {
  setSessionsInternal(reconcile(await api<SessionRow[]>("/api/sessions"), { key: "id" }));
}

export async function refreshSessions() {
  await refreshSessionsQuiet();
  if (selected() && !sessions.some((s) => s.id === selected())) setSelectedInternal(null);
  if (!selected() && sessions.length > 0) await select(sessions[0].id);
}

export async function select(id: string) {
  setSelectedInternal(id);
  setUnread((prev) => {
    const next = new Set(prev);
    next.delete(id);
    return next;
  });
  setPillTarget(null);
  setNavOpen(false);
  setStreamLoadingInternal(true);
  setSurfacesInternal(reconcile([]));
  setCommentsInternal([]);
  const metas = await api<{ id: string }[]>(`/api/sessions/${id}/surfaces`).catch(() => []);
  const details = (
    await Promise.all(metas.map((m) => api<Surface>(`/api/surfaces/${m.id}`).catch(() => null)))
  ).filter((s) => s !== null);
  if (selected() !== id) return; // user switched away mid-load
  setSurfacesInternal(reconcile(details, { key: "id" }));
  setStreamLoadingInternal(false);
  const res = await api<{ comments: Comment[] }>(`/api/comments?session=${id}`).catch(() => null);
  if (!res || selected() !== id) return;
  mergeComments(res.comments);
}

// Switch to the session above (-1) or below (+1) the current one in the
// sidebar list, wrapping at the ends so repeated presses cycle. Drives the
// Cmd+Option+Up/Down shortcut. No-op with no sessions; jumps to the first
// when nothing is selected yet.
export async function selectAdjacent(delta: 1 | -1) {
  if (sessions.length === 0) return;
  const idx = sessions.findIndex((s) => s.id === selected());
  if (idx < 0) {
    await select(sessions[0].id);
    return;
  }
  const next = (idx + delta + sessions.length) % sessions.length;
  await select(sessions[next].id);
}

// Fetch a surface and insert/update it in the open session's stream.
async function upsertSurface(id: string, { scroll = true } = {}) {
  const s = await api<Surface>(`/api/surfaces/${id}`).catch(() => null);
  if (!s || s.sessionId !== selected()) return;
  const idx = surfaces.findIndex((x) => x.id === s.id);
  if (idx >= 0) {
    setSurfacesInternal(idx, reconcile(s));
  } else {
    // Follow new surfaces only when the user is already at the bottom;
    // never yank them away from whatever they're reading mid-scroll.
    if (scroll) {
      if (nearBottom()) setScrollTarget(s.id);
      else setPillTarget(s.id);
    }
    setSurfacesInternal(surfaces.length, s);
  }
}

export function nearBottom() {
  const m = document.querySelector("main");
  return !!m && m.scrollHeight - m.scrollTop - m.clientHeight < 200;
}

function mergeComments(list: Comment[]) {
  setCommentsInternal((prev) => {
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
  surfaceId: string | null,
  text: string,
): Promise<string | null> {
  const local: ViewComment = {
    id: `local-${++localSeq}`,
    seq: 0,
    sessionId: selected() ?? "",
    surfaceId,
    surfaceTitle: null,
    author: "user",
    text,
    createdAt: new Date().toISOString(),
    pending: true,
  };
  setCommentsInternal((prev) => [...prev, local]);
  try {
    const created = await api<Comment>("/api/comments", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setCommentsInternal((prev) => {
      // the SSE refetch may have rendered it already; keep one copy
      if (prev.some((c) => c.id === created.id)) return prev.filter((c) => c.id !== local.id);
      return prev.map((c) => (c.id === local.id ? created : c));
    });
    return null;
  } catch (err) {
    setCommentsInternal((prev) => prev.filter((c) => c.id !== local.id));
    return err instanceof Error && err.message ? err.message : "network error";
  }
}

interface FeedEvent {
  type: string;
  id: string;
  sessionId?: string;
  surfaceId?: string | null;
}

export function connect() {
  const es = new EventSource("/api/events");
  let everConnected = false;
  es.onopen = async () => {
    setLiveInternal(true);
    // events that fired during a gap are gone for good — refetch so the
    // board can't silently go stale while still looking live
    if (everConnected) await resyncSelected();
    everConnected = true;
  };
  es.onerror = () => setLiveInternal(false);
  es.onmessage = async (ev) => {
    const e = JSON.parse(ev.data) as FeedEvent;
    // activity the user isn't looking at — other session or hidden tab —
    // marks the session unread, which also badges the tab title
    const away = e.sessionId != null && (e.sessionId !== selected() || document.hidden);
    if (e.type === "theme-changed") {
      applyTheme(e.id);
    } else if (e.type.startsWith("session-")) {
      await refreshSessions();
    } else if (e.type === "surface-created" || e.type === "surface-updated") {
      if (away && e.sessionId) markUnread(e.sessionId);
      if (e.sessionId === selected()) await upsertSurface(e.id);
      await refreshSessionsQuiet();
    } else if (e.type === "surface-deleted") {
      const idx = surfaces.findIndex((s) => s.id === e.id);
      if (idx >= 0) setSurfacesInternal(produce((arr) => arr.splice(idx, 1)));
      await refreshSessionsQuiet();
    } else if (e.type === "comment-created") {
      if (away && e.sessionId) markUnread(e.sessionId);
      if (e.sessionId === selected()) {
        const query = e.surfaceId ? `surface=${e.surfaceId}` : `session=${e.sessionId}`;
        const res = await api<{ comments: Comment[] }>(`/api/comments?${query}`);
        mergeComments(res.comments);
      }
    }
  };
}

// Re-fetch the selected session's surfaces and comments after an SSE
// reconnect; surfaces reconcile by id and comments dedupe by id.
async function resyncSelected() {
  const before = selected();
  await refreshSessions();
  if (!before || selected() !== before) return; // select() rebuilt the stream
  const metas = await api<{ id: string }[]>(`/api/sessions/${before}/surfaces`).catch(() => []);
  const ids = new Set(metas.map((m) => m.id));
  setSurfacesInternal(
    produce((arr) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (!ids.has(arr[i].id)) arr.splice(i, 1);
      }
    }),
  );
  for (const meta of metas) await upsertSurface(meta.id, { scroll: false });
  const res = await api<{ comments: Comment[] }>(`/api/comments?session=${before}`).catch(
    () => null,
  );
  if (res && selected() === before) mergeComments(res.comments);
}

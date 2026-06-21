// Shared state and the flows that mutate it. Stores reconcile by id so DOM
// rows/cards persist across refetches (focus, composer drafts, iframes).
import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import {
  api,
  appPath,
  isReadonly,
  publicReadMode,
  type Comment,
  type SessionRow,
  type Surface,
  type TraceStep,
  type VersionInfo,
} from "./api.ts";
import { applyTheme } from "./theme.ts";

// --- URL routing ---
// /session/:id            → viewer with that session selected
// /session/:id/s/:sid     → viewer with session selected, surface focused
// /                       → redirect to last-viewed session (localStorage)
const LAST_SESSION_KEY = "sideshow-last-session";

export function parseRoute(pathname: string): { sessionId?: string; surfaceId?: string } {
  const match = pathname.match(/^\/session\/([^/]+)(?:\/s\/([^/]+))?/);
  if (match) return { sessionId: match[1], surfaceId: match[2] };
  return {};
}

function pushSessionUrl(id: string) {
  const target = `/session/${id}`;
  if (window.location.pathname !== target) {
    history.pushState(null, "", target);
  }
}

function replaceSurfaceUrl(sessionId: string, surfaceId: string) {
  history.replaceState(null, "", `/session/${sessionId}/s/${surfaceId}`);
}

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
// Session-scoped agent trace steps for the selected session (timeline view).
const [traceStepsState, setTraceStepsInternal] = createSignal<TraceStep[]>([]);
export const traceSteps = traceStepsState;
const [streamLoadingState, setStreamLoadingInternal] = createSignal(false);
export const streamLoading = streamLoadingState;
const [liveState, setLiveInternal] = createSignal(false);
export const live = liveState;
export const [navOpen, setNavOpen] = createSignal(false);
// Stream (cards top-to-bottom) vs. timeline (treatment E: surfaces on a center
// spine with the trace steps between them). Per-board view preference.
export type ViewMode = "stream" | "timeline";
export const [viewMode, setViewMode] = createSignal<ViewMode>("stream");
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
  if (isReadonly() && publicReadMode() === "session") return;
  setSessionsInternal(reconcile(await api<SessionRow[]>("/api/sessions"), { key: "id" }));
}

function syntheticSession(id: string): SessionRow {
  const now = new Date().toISOString();
  return {
    id,
    agent: "",
    title: null,
    cwd: null,
    createdAt: now,
    lastActiveAt: now,
    agentSeq: 0,
    surfaceCount: 0,
  };
}

export async function refreshSessions(targetSurfaceId?: string | null) {
  if (isReadonly() && publicReadMode() === "session") {
    const route = parseRoute(window.location.pathname);
    if (!route.sessionId) return;
    if (!sessions.some((s) => s.id === route.sessionId)) {
      setSessionsInternal(reconcile([syntheticSession(route.sessionId)], { key: "id" }));
    }
    await select(route.sessionId, { replace: true, initialSurfaceId: route.surfaceId });
    return;
  }

  await refreshSessionsQuiet();
  if (selected() && !sessions.some((s) => s.id === selected())) setSelectedInternal(null);
  if (targetSurfaceId) {
    const target = await api<Surface>(`/api/surfaces/${encodeURIComponent(targetSurfaceId)}`).catch(
      () => null,
    );
    if (target && sessions.some((s) => s.id === target.sessionId)) {
      await select(target.sessionId, { replace: true, initialSurfaceId: target.id });
      return;
    }
  }

  if (!selected() && sessions.length > 0) {
    // Check the URL first, then localStorage, then fall back to first session.
    const route = parseRoute(window.location.pathname);
    const lastId = localStorage.getItem(LAST_SESSION_KEY);
    const target =
      (route.sessionId && sessions.some((s) => s.id === route.sessionId) && route.sessionId) ||
      (lastId && sessions.some((s) => s.id === lastId) && lastId) ||
      sessions[0].id;
    await select(target, {
      replace: true,
      initialSurfaceId: target === route.sessionId ? route.surfaceId : undefined,
    });
  }
}

export async function select(
  id: string,
  opts?: { fromPopState?: boolean; replace?: boolean; initialSurfaceId?: string },
) {
  setSelectedInternal(id);
  if (opts?.fromPopState) {
    // Browser already moved the history; don't touch it.
  } else if (opts?.replace) {
    history.replaceState(
      null,
      "",
      opts.initialSurfaceId ? `/session/${id}/s/${opts.initialSurfaceId}` : `/session/${id}`,
    );
  } else {
    pushSessionUrl(id);
  }
  localStorage.setItem(LAST_SESSION_KEY, id);
  setUnread((prev) => {
    const next = new Set(prev);
    next.delete(id);
    return next;
  });
  setScrollTarget(null);
  setPillTarget(null);
  setNavOpen(false);
  setStreamLoadingInternal(true);
  setSurfacesInternal(reconcile([]));
  setCommentsInternal([]);
  setTraceStepsInternal([]);
  void fetchTrace(id);
  const metas = await api<{ id: string }[]>(`/api/sessions/${id}/surfaces`).catch(() => []);
  const details = (
    await Promise.all(metas.map((m) => api<Surface>(`/api/surfaces/${m.id}`).catch(() => null)))
  ).filter((s) => s !== null);
  if (selected() !== id) return; // user switched away mid-load
  setSurfacesInternal(reconcile(details, { key: "id" }));
  // Scroll to a specific surface if requested (deep link).
  if (opts?.initialSurfaceId && details.some((s) => s.id === opts.initialSurfaceId)) {
    setScrollTarget(opts.initialSurfaceId);
    replaceSurfaceUrl(id, opts.initialSurfaceId);
  }
  setStreamLoadingInternal(false);
  const res = await api<{ comments: Comment[] }>(`/api/comments?session=${id}`).catch(() => null);
  if (!res || selected() !== id) return;
  mergeComments(res.comments);
}

// Update the URL to reflect the currently visible surface (replaceState so
// scrolling doesn't pollute browser history).
export function focusSurface(surfaceId: string) {
  const sid = selected();
  if (sid) replaceSurfaceUrl(sid, surfaceId);
}

// Handle browser back/forward by re-selecting the session from the URL.
export function handlePopState() {
  const route = parseRoute(window.location.pathname);
  if (route.sessionId && route.sessionId !== selected()) {
    void select(route.sessionId, { fromPopState: true, initialSurfaceId: route.surfaceId });
  }
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

// Fetch the session's trace steps (timeline view). Ignored if the user has
// switched away by the time it resolves.
export async function fetchTrace(sessionId: string) {
  const res = await api<{ steps: TraceStep[] }>(`/api/sessions/${sessionId}/trace`).catch(
    () => null,
  );
  if (res && selected() === sessionId) setTraceStepsInternal(res.steps);
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
  const route = parseRoute(window.location.pathname);
  const sessionId = route.sessionId ?? selected();
  const eventsPath =
    isReadonly() && publicReadMode() === "session" && sessionId
      ? `/api/events?session=${encodeURIComponent(sessionId)}`
      : "/api/events";
  const es = new EventSource(appPath(eventsPath));
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
    } else if (e.type === "trace-updated") {
      // the agent working is ambient, not an alert — refetch quietly, no badge
      if (e.sessionId === selected()) await fetchTrace(e.sessionId);
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
  void fetchTrace(before);
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

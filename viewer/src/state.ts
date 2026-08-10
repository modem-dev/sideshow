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
  type Post,
  type TraceStep,
  type VersionInfo,
} from "./api.ts";
import { host, root, type Route } from "./host.ts";
import { applyTheme } from "./theme.ts";

// --- URL routing ---
// The host owns the URL. The engine renders whatever route host.router.get()
// reports and asks host.router.navigate() to move; the default (self-hosted)
// host maps that onto /session/:id and /session/:id/s/:sid over the History API.
// /                       → redirect to last-viewed session (localStorage)
const LAST_SESSION_KEY = "sideshow-last-session";

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
// bucket, sessions with no posts yet sink to the bottom (and render dimmed)
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

// Standalone (direct-link) mode: a bare /s/:id route with no session shows that
// one post full-page — no sidebar, no session feed, no comments — instead of
// resolving it into its session's stream. Holds the fetched post while in
// that mode; null is the normal workspace. The server serves the same SPA shell for
// /s/:id (with link-preview metadata, see server/app.ts); the viewer decides the
// layout from the route here.
const [standaloneState, setStandaloneInternal] = createSignal<Post | null>(null);
export const standalonePost = standaloneState;
export const [unread, setUnread] = createSignal<ReadonlySet<string>>(new Set<string>());
const [postsStore, setPostsInternal] = createStore<Post[]>([]);
export const posts = postsStore;
const [commentsState, setCommentsInternal] = createSignal<ViewComment[]>([]);
export const comments = commentsState;
// Session-scoped agent trace steps for the selected session (timeline view).
const [traceStepsState, setTraceStepsInternal] = createSignal<TraceStep[]>([]);
export const traceSteps = traceStepsState;
const [streamLoadingState, setStreamLoadingInternal] = createSignal(false);
export const streamLoading = streamLoadingState;
// False until the first session list has been fetched, so the workspace's
// onboard/session panes aren't decided — and so rendered — before we know which
// to show. Flipped once (in App.onMount, after the initial refreshSessions
// resolves); the empty-workspace onboarding is gated on it so it never flashes
// during that first fetch (an embedding host also keys its loading overlay off
// the matching host.onReady signal).
const [initialLoadedState, setInitialLoadedInternal] = createSignal(false);
export const initialLoaded = initialLoadedState;
export const setInitialLoaded = setInitialLoadedInternal;
const [liveState, setLiveInternal] = createSignal(false);
export const live = liveState;
export const [navOpen, setNavOpen] = createSignal(false);
// Stream (cards top-to-bottom) vs. timeline (treatment E: posts on a center
// spine with the trace steps between them). Per-workspace view preference.
export type ViewMode = "stream" | "timeline";
export const [viewMode, setViewMode] = createSignal<ViewMode>("stream");
// Post id the next mounted card should scroll to (set for SSE arrivals
// landing while the user is near the bottom, not the initial batch of a
// session switch).
export const [scrollTarget, setScrollTarget] = createSignal<string | null>(null);
// Post id the "new post ↓" pill jumps to — set instead of scrolling
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

let sessionRefreshRequestVersion = 0;
let latestAppliedSessionRefreshVersion = 0;
let latestSessionRefresh = Promise.resolve();

export async function refreshSessionsQuiet() {
  if (isReadonly() && publicReadMode() === "session") return;
  const requestVersion = ++sessionRefreshRequestVersion;
  const refresh = (async () => {
    const next = await api<SessionRow[]>("/api/sessions").catch(() => null);
    // A feed refresh may overlap an immediate lifecycle/reconnect/poll refresh.
    // Apply the newest successful response seen so far: a slower older response
    // cannot roll back newer rendered state, but it remains a valid fallback if
    // every request that started after it fails.
    // This quiet refresh is best-effort: polling or the next event repairs a
    // failed request without rejecting into timer/feed callbacks.
    if (next && requestVersion > latestAppliedSessionRefreshVersion) {
      latestAppliedSessionRefreshVersion = requestVersion;
      setSessionsInternal(reconcile(next, { key: "id" }));
    }
  })();
  latestSessionRefresh = refresh;
  await refresh;

  // Callers such as bootstrap and reconnect use resolution to mean the current
  // session list is ready. If this request was superseded, wait through the
  // newest request rather than returning after deliberately ignoring our row.
  while (refresh !== latestSessionRefresh) {
    const latest = latestSessionRefresh;
    await latest;
    if (latest === latestSessionRefresh) return;
  }
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

// Entry point on load: a bare post route (/s/:id, no session) opens the
// full-page standalone view; anything else falls through to the normal workspace.
// If the post can't be fetched (deleted / bad id) we drop to the workspace so the
// user lands somewhere usable rather than a blank page.
export async function bootstrap() {
  const route = host().router.get();
  if (route.surfaceId && !route.sessionId) {
    await enterStandalone(route.surfaceId);
    if (standalonePost()) return;
  }
  await refreshSessions(route.surfaceId);
}

// Fetch a post and switch into standalone mode. No-op if already showing it.
export async function enterStandalone(id: string) {
  if (standalonePost()?.id === id) return;
  const post = await api<Post>(`/api/posts/${encodeURIComponent(id)}`).catch(() => null);
  if (post) setStandaloneInternal(post);
}

function isConnectRoute(): boolean {
  return location.pathname === appPath("/connect");
}

export async function refreshSessions(targetPostId?: string | null) {
  if (isReadonly() && publicReadMode() === "session") {
    const route = host().router.get();
    if (!route.sessionId && targetPostId) {
      const target = await api<Post>(`/api/posts/${encodeURIComponent(targetPostId)}`).catch(
        () => null,
      );
      if (!target) return;
      if (!sessions.some((s) => s.id === target.sessionId)) {
        setSessionsInternal(reconcile([syntheticSession(target.sessionId)], { key: "id" }));
      }
      await select(target.sessionId, { replace: true, initialPostId: target.id });
      return;
    }
    if (!route.sessionId) return;
    if (!sessions.some((s) => s.id === route.sessionId)) {
      setSessionsInternal(reconcile([syntheticSession(route.sessionId)], { key: "id" }));
    }
    await select(route.sessionId, {
      replace: true,
      initialPostId: route.surfaceId ?? undefined,
    });
    return;
  }

  await refreshSessionsQuiet();
  if (selected() && !sessions.some((s) => s.id === selected())) setSelectedInternal(null);
  if (targetPostId) {
    const target = await api<Post>(`/api/posts/${encodeURIComponent(targetPostId)}`).catch(
      () => null,
    );
    if (target && sessions.some((s) => s.id === target.sessionId)) {
      await select(target.sessionId, { replace: true, initialPostId: target.id });
      return;
    }
  }

  if (!selected() && sessions.length > 0) {
    // Check the route first, then localStorage, then fall back to first session.
    // A host that owns a session-less landing (homeView) skips that fallback: it
    // honors a deep-linked route session but otherwise stays session-less so the
    // host's home shows with nothing selected (no auto-open, no highlight).
    const route = host().router.get();
    const lastId = localStorage.getItem(LAST_SESSION_KEY);
    const fallback =
      host().homeView || isConnectRoute()
        ? null
        : (lastId && sessions.some((s) => s.id === lastId) && lastId) || sessions[0].id;
    const target =
      (route.sessionId && sessions.some((s) => s.id === route.sessionId) && route.sessionId) ||
      fallback;
    if (target) {
      await select(target, {
        replace: true,
        initialPostId: target === route.sessionId ? (route.surfaceId ?? undefined) : undefined,
      });
    }
  }
}

function isHydratedPost(value: unknown): value is Post {
  return !!value && typeof value === "object" && Array.isArray((value as Post).history);
}

async function fetchSessionPostDetails(id: string): Promise<Post[]> {
  const rows = await api<unknown[]>(`/api/sessions/${id}/posts?hydrate=1`).catch(() => []);
  const hydrated: Post[] = [];
  for (const row of rows) {
    if (isHydratedPost(row)) hydrated.push(row);
  }
  if (hydrated.length === rows.length) return hydrated;
  const details = await Promise.all(
    rows.map((row) =>
      row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string"
        ? api<Post>(`/api/posts/${encodeURIComponent((row as { id: string }).id)}`).catch(
            () => null,
          )
        : null,
    ),
  );
  return details.filter((post): post is Post => post !== null);
}

export async function select(
  id: string,
  opts?: { fromPopState?: boolean; replace?: boolean; initialPostId?: string },
) {
  setSelectedInternal(id);
  if (opts?.fromPopState) {
    // The host already moved the route (back/forward); don't touch it.
  } else if (opts?.replace) {
    host().router.navigate({ sessionId: id, surfaceId: opts.initialPostId }, { replace: true });
  } else {
    host().router.navigate({ sessionId: id });
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
  setPostsInternal(reconcile([]));
  setCommentsInternal([]);
  setTraceStepsInternal([]);
  void fetchTrace(id);
  const details = await fetchSessionPostDetails(id);
  if (selected() !== id) return; // user switched away mid-load
  setPostsInternal(reconcile(details, { key: "id" }));
  // Scroll to a specific post if requested (deep link).
  if (opts?.initialPostId && details.some((s) => s.id === opts.initialPostId)) {
    setScrollTarget(opts.initialPostId);
    host().router.navigate({ sessionId: id, surfaceId: opts.initialPostId }, { replace: true });
  }
  setStreamLoadingInternal(false);
  const res = await api<{ comments: Comment[] }>(`/api/comments?session=${id}`).catch(() => null);
  if (!res || selected() !== id) return;
  mergeComments(res.comments);
}

// Reflect the currently visible post in the route (replace, so scrolling
// doesn't pollute history).
export function focusPost(postId: string) {
  const sid = selected();
  if (sid) host().router.navigate({ sessionId: sid, surfaceId: postId }, { replace: true });
}

// Return to "home" — the session-less base route — and drop the current
// selection. Drives the clickable sidebar brand: a guaranteed way back to the
// empty workspace from anywhere. Always asks the host to navigate (never short-
// circuits on the engine's own state): an embedding host may layer its own view
// over the workspace — e.g. sideshow cloud's full-page Settings, which has no
// session links to click out of on an empty workspace — and only this navigate()
// clears it. The host itself dedupes a no-op move. applyRoute ignores a null
// sessionId (back/forward to home shouldn't thrash a load), so we deselect here.
export function goHome() {
  setSelectedInternal(null);
  setNavOpen(false);
  host().router.navigate({ sessionId: null, surfaceId: null });
}

// Re-select the session when the host's route changes (back/forward).
export function applyRoute(route: Route) {
  // A bare post route is the standalone full-page view; back/forward into or
  // out of it toggles the mode (leaving it falls through to session handling).
  if (route.surfaceId && !route.sessionId) {
    void enterStandalone(route.surfaceId);
    return;
  }
  if (standalonePost()) setStandaloneInternal(null);
  if (route.sessionId && route.sessionId !== selected()) {
    void select(route.sessionId, {
      fromPopState: true,
      initialPostId: route.surfaceId ?? undefined,
    });
  } else if (!route.sessionId && host().homeView && selected()) {
    // A host that owns a session-less landing: a route with no session IS that
    // home view, so clear the selection — otherwise the previously-open session
    // stays highlighted behind the host's home. (Self-hosted leaves homeView off
    // and keeps ignoring a null route here; it deselects explicitly via goHome.)
    setSelectedInternal(null);
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

// Fetch a post and insert/update it in the open session's stream.
async function upsertPost(id: string, { scroll = true } = {}) {
  const s = await api<Post>(`/api/posts/${id}`).catch(() => null);
  if (!s || s.sessionId !== selected()) return;
  const idx = posts.findIndex((x) => x.id === s.id);
  if (idx >= 0) {
    setPostsInternal(idx, reconcile(s, { key: "id" }));
  } else {
    // Follow new posts only when the user is already at the bottom;
    // never yank them away from whatever they're reading mid-scroll.
    if (scroll) {
      if (nearBottom()) setScrollTarget(s.id);
      else setPillTarget(s.id);
    }
    setPostsInternal(posts.length, s);
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
  const m = root().querySelector("main");
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
export async function deleteComment(id: string): Promise<string | null> {
  const prior = commentsState();
  setCommentsInternal((prev) => prev.filter((c) => c.id !== id));
  try {
    await api(`/api/comments/${encodeURIComponent(id)}`, { method: "DELETE" });
    return null;
  } catch (err) {
    setCommentsInternal(prior);
    return err instanceof Error && err.message ? err.message : "network error";
  }
}

export async function sendComment(
  body: Record<string, unknown>,
  postId: string | null,
  text: string,
): Promise<string | null> {
  const anchor = body.anchor as Comment["anchor"] | undefined;
  const local: ViewComment = {
    id: `local-${++localSeq}`,
    seq: 0,
    sessionId: selected() ?? "",
    postId,
    postTitle: null,
    author: "user",
    text,
    createdAt: new Date().toISOString(),
    ...(anchor && { anchor }),
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

const WS_HEARTBEAT_MS = 30_000;
const WS_RECONNECT_MS = 1000;
const FEED_SESSION_REFRESH_DELAY_MS = 50;
const FEED_SESSION_REFRESH_MAX_WAIT_MS = 250;

let feedSessionRefreshVersion = 0;
let pendingFeedSessionRefresh: Promise<void> | undefined;

// A publish burst delivers one feed event per post. The cards still fetch and
// reconcile independently, but their sidebar metadata can share one trailing
// session-list refresh. Manual/bootstrap refreshes continue to run immediately.
function refreshSessionsAfterFeedEvent(): Promise<void> {
  if (isReadonly() && publicReadMode() === "session") return Promise.resolve();
  feedSessionRefreshVersion++;
  pendingFeedSessionRefresh ??= (async () => {
    let refreshedVersion = 0;
    while (refreshedVersion !== feedSessionRefreshVersion) {
      // Restart the quiet window whenever another event lands, but cap a
      // continuously active batch so sidebar metadata cannot wait indefinitely.
      // If an event arrives after the request starts, the outer loop performs
      // one trailing refresh rather than overlapping requests or losing it.
      const batchStartedAt = Date.now();
      let queuedVersion: number;
      do {
        queuedVersion = feedSessionRefreshVersion;
        const remaining = FEED_SESSION_REFRESH_MAX_WAIT_MS - (Date.now() - batchStartedAt);
        if (remaining <= 0) break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(FEED_SESSION_REFRESH_DELAY_MS, remaining)),
        );
      } while (queuedVersion !== feedSessionRefreshVersion);
      refreshedVersion = feedSessionRefreshVersion;
      await refreshSessionsQuiet();
    }
  })().finally(() => {
    pendingFeedSessionRefresh = undefined;
  });
  return pendingFeedSessionRefresh;
}

function eventsPath(): string {
  const route = host().router.get();
  const sessionId = route.sessionId ?? selected() ?? standalonePost()?.sessionId;
  return isReadonly() && publicReadMode() === "session" && sessionId
    ? `/api/events?session=${encodeURIComponent(sessionId)}`
    : "/api/events";
}

function wsAppUrl(path: string): string {
  const url = new URL(appPath(path), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

async function handleFeedData(data: string) {
  if (data === "pong") return;
  const e = JSON.parse(data) as FeedEvent;
  // activity the user isn't looking at — other session or hidden tab —
  // marks the session unread, which also badges the tab title
  const away = e.sessionId != null && (e.sessionId !== selected() || document.hidden);
  if (e.type === "theme-changed") {
    applyTheme(e.id);
  } else if (e.type.startsWith("session-")) {
    await refreshSessions();
  } else if (e.type === "post-created" || e.type === "post-updated") {
    if (away && e.sessionId) markUnread(e.sessionId);
    const sessionRefresh = refreshSessionsAfterFeedEvent();
    if (e.sessionId === selected()) await upsertPost(e.id);
    await sessionRefresh;
  } else if (e.type === "post-deleted") {
    const idx = posts.findIndex((s) => s.id === e.id);
    if (idx >= 0) setPostsInternal(produce((arr) => arr.splice(idx, 1)));
    await refreshSessionsAfterFeedEvent();
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
  } else if (e.type === "comment-deleted") {
    setCommentsInternal((prev) => prev.filter((c) => c.id !== e.id));
  }
}

export function connect(): () => void {
  if (host().liveTransport === "ws") return connectWebSocket();
  return connectSse();
}

function connectSse(): () => void {
  const es = new EventSource(appPath(eventsPath()));
  let everConnected = false;
  es.onopen = async () => {
    setLiveInternal(true);
    // events that fired during a gap are gone for good — refetch so the
    // workspace can't silently go stale while still looking live
    if (everConnected) await resyncSelected();
    everConnected = true;
  };
  es.onerror = () => setLiveInternal(false);
  es.onmessage = (ev) => void handleFeedData(ev.data);
  return () => {
    es.close();
    setLiveInternal(false);
  };
}

function connectWebSocket(): () => void {
  const url = wsAppUrl(eventsPath());
  let everConnected = false;
  let closed = false;
  let ws: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;

  const clearHeartbeat = () => {
    clearInterval(heartbeat);
    heartbeat = undefined;
  };

  const open = () => {
    if (closed) return;
    ws = new WebSocket(url);

    ws.onopen = async () => {
      setLiveInternal(true);
      clearHeartbeat();
      heartbeat = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
      }, WS_HEARTBEAT_MS);
      // events that fired during a gap are gone for good — refetch so the
      // workspace can't silently go stale while still looking live
      if (everConnected) await resyncSelected();
      everConnected = true;
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") void handleFeedData(ev.data);
    };
    ws.onerror = () => setLiveInternal(false);
    ws.onclose = () => {
      setLiveInternal(false);
      clearHeartbeat();
      if (!closed) reconnect = setTimeout(open, WS_RECONNECT_MS);
    };
  };

  open();
  return () => {
    closed = true;
    clearTimeout(reconnect);
    clearHeartbeat();
    ws?.close();
    setLiveInternal(false);
  };
}

// Re-fetch the selected session's posts and comments after a live-feed
// reconnect; posts reconcile by id and comments dedupe by id.
async function resyncSelected() {
  const before = selected();
  await refreshSessions();
  if (!before || selected() !== before) return; // select() rebuilt the stream
  void fetchTrace(before);
  const details = await fetchSessionPostDetails(before);
  const ids = new Set(details.map((post) => post.id));
  setPostsInternal(
    produce((arr) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (!ids.has(arr[i].id)) arr.splice(i, 1);
      }
    }),
  );
  if (selected() === before) setPostsInternal(reconcile(details, { key: "id" }));
  const res = await api<{ comments: Comment[] }>(`/api/comments?session=${before}`).catch(
    () => null,
  );
  if (res && selected() === before) mergeComments(res.comments);
}

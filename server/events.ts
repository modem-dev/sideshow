export type FeedEvent =
  | { type: "session-created" | "session-updated" | "session-deleted"; id: string }
  | { type: "surface-created" | "surface-updated"; id: string; sessionId: string; version: number }
  | { type: "surface-deleted"; id: string; sessionId: string }
  | {
      type: "comment-created";
      id: string;
      sessionId: string;
      surfaceId: string | null;
      seq: number;
    }
  // Board theme changed; `id` is the new theme id. Other open tabs re-theme.
  | { type: "theme-changed"; id: string };

type Listener = (event: FeedEvent) => void;

// One bus per app instance. On Cloudflare, each board is a single Durable
// Object running one app, so in-memory listeners are correct there too —
// a module-level singleton would leak events across boards sharing an isolate.
export class EventBus {
  private listeners = new Set<Listener>();

  broadcast(event: FeedEvent) {
    for (const fn of this.listeners) fn(event);
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

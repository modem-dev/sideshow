// Public types for the embeddable engine (`sideshow/viewer-embed`). The runtime
// is the Vite-built viewer/dist-embed/engine.js; these declarations describe its
// surface so hosts get types without depending on the viewer source.

export type Route = { sessionId?: string | null; surfaceId?: string | null };

export interface HostRouter {
  /** The route the engine should render. */
  get(): Route;
  /** Ask the host to navigate; `replace` swaps history instead of pushing. */
  navigate(to: Route, opts?: { replace?: boolean }): void;
  /** Notify the engine when the host's route changes (back/forward, etc). */
  subscribe(cb: (route: Route) => void): () => void;
}

export interface SideshowHost {
  /** Link/base prefix the engine prepends to every path, e.g. "/u/alice" (""). */
  basePath: string;
  router: HostRouter;
  /** The caller's own identity, when the host knows it. */
  identity?: { login: string; accountSlug?: string; role?: string };
  /**
   * Layout the engine renders. "full" (default) shows the sidebar + stream;
   * "stream" shows only the current session's stream — no sidebar, session list,
   * or session chrome. (Self-hosted public-read "session" links map to "stream".)
   */
  layout?: "full" | "stream";
  /**
   * Read-only embed: hide write affordances (delete, comment-as-owner, connect).
   * Orthogonal to `layout`. Self-hosted drives the same flag via a window global.
   */
  readonly?: boolean;
}

export interface ViewerHandle {
  dispose(): void;
}

/**
 * Mount the viewer engine into `el` (it attaches its own shadow root). Pass a
 * host to own the base path + routing; omit it to use the default History-API
 * host (drop-in for the self-hosted page).
 */
export function mountViewer(el: Element, host?: SideshowHost): ViewerHandle;

/**
 * Host-overridable layout regions. The engine wraps each in a `<slot name="...">`
 * whose fallback is the self-hosted default; an embedder replaces a whole region
 * by projecting a light-DOM child with the matching `slot=` attribute into the
 * mount element. Regions, not strings — kept small and coarse on purpose.
 */
export declare const SLOTS: {
  /** Sidebar footer: doc links, connect action, theme picker. */
  readonly asideFoot: "ss:aside-foot";
  /** Empty-board onboarding shown before any session exists. */
  readonly empty: "ss:empty";
};

export type SlotName = (typeof SLOTS)[keyof typeof SLOTS];

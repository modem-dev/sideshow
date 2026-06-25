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
  /**
   * Whether this deployment can render a surface as a PNG (the /s/:id.png route).
   * That route needs Cloudflare Browser Rendering, so it exists only on a Workers
   * deployment; elsewhere the engine shows the per-surface screenshot action but
   * disables it with an explanatory tooltip. An embedder on Cloudflare sets this
   * true; self-hosted drives the same flag via a window global. Defaults to off.
   */
  screenshots?: boolean;
  /**
   * The engine calls this with the fully-resolved palette on initial mount, on
   * every live theme switch, and on an OS light/dark flip — symmetric with
   * `router.navigate`. A host mirrors the tokens onto its own chrome instead of
   * scraping computed styles across the shadow boundary. Optional — the trivial
   * self-hosted host omits it.
   */
  onThemeChange?(tokens: ThemeTokens): void;
  /**
   * Called once, after the engine's first session-list fetch resolves and the
   * initial board (a session, or the empty-board onboarding) is decided — the
   * moment the engine knows what to show. Hold a loading overlay over the mount
   * until then to avoid showing the pre-load board flash; the engine's own
   * onboarding pane is internally gated on the same signal. Fires even if that
   * fetch failed (board falls back to onboarding), so an overlay can't get
   * stuck. Optional — the trivial self-hosted host omits it.
   */
  onReady?(): void;
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
  /**
   * Empty-sidebar affordance shown in the session list when no sessions exist.
   * Fallback is a native "Connect an agent" row that scrolls to the empty-board
   * pane (ss:empty); project a `slot="ss:aside-empty"` child for a host-specific
   * nudge. Renders only on an empty (post-load) board.
   */
  readonly asideEmpty: "ss:aside-empty";
  /** Empty-board onboarding shown before any session exists. */
  readonly empty: "ss:empty";
  /** Per-session actions in the session header, beside the stream/timeline toggle. */
  readonly sessionActions: "ss:session-actions";
  /**
   * The whole main content pane (onboarding + session stream). Fallback is the
   * normal board; project a `slot="ss:main"` child to take over the main area
   * (e.g. a cloud Settings page) while the sidebar stays. Meant to be projected
   * conditionally — when no child is assigned the engine shows the board.
   */
  readonly main: "ss:main";
};

export type SlotName = (typeof SLOTS)[keyof typeof SLOTS];

/**
 * Theme-token contract. The engine renders its palette as these CSS custom
 * properties; a host mirrors the same set onto its own chrome. The canonical,
 * engine-free entry is `sideshow/theme-tokens` (Node-safe, no viewer runtime) —
 * prefer it in build scripts; these re-exports exist so a host that already pulls
 * the engine bundle has them too.
 *
 * The coarse subset of palette vars a host mirrors (not the per-state --color-*
 * or --term-* tokens).
 */
export declare const THEME_TOKEN_NAMES: readonly [
  "--bg",
  "--panel",
  "--surface",
  "--text",
  "--muted",
  "--faint",
  "--border",
  "--border-2",
  "--accent",
  "--accent-bg",
  "--hover",
  "--danger",
];

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Record<ThemeTokenName, string>;

/**
 * The engine's built-in default-theme values, so a host can paint correct colors
 * before the engine has resolved a theme (the no-flash fallback). Derived from
 * the engine's theme registry — never hand-copied.
 */
export declare const THEME_DEFAULTS: Record<"light" | "dark", ThemeTokens>;

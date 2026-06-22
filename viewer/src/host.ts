// The host seam. The viewer is an embeddable "engine": it renders into a root
// (the whole document when self-hosted, a shadow root when embedded) and reads
// its base path + route from an injected host instead of touching window/
// location directly. Whoever provides the host owns the URL, chrome, and
// routing; self-hosted sideshow ships the trivial default host below.
//
// Self-hosted parity: when nothing is injected, root() is `document` and host()
// is a History-API host whose URLs/behaviour match the pre-engine viewer
// exactly. The embed path (mountViewer) calls setEngine() with a shadow root +
// the embedder's host before <App/> renders.

export type Route = { sessionId?: string | null; surfaceId?: string | null };

export interface HostRouter {
  // The current route the engine should render.
  get(): Route;
  // Ask the host to navigate; `replace` swaps history instead of pushing.
  navigate(to: Route, opts?: { replace?: boolean }): void;
  // Notify the engine when the host's route changes (back/forward, etc).
  subscribe(cb: (route: Route) => void): () => void;
}

export interface SideshowHost {
  // Link/base prefix the engine prepends to every path, e.g. "/u/alice" ("" at
  // root). API calls are `${basePath}/api/...`.
  basePath: string;
  router: HostRouter;
  // The caller's own identity, when the host knows it (cloud chrome). Optional —
  // self-hosted has no identity.
  identity?: { login: string; accountSlug?: string; role?: string };
  // Layout the engine renders. "full" (default) shows the sidebar + stream;
  // "stream" shows only the current session's stream — no sidebar, session list,
  // or session chrome. Self-hosted public-read "session" links map to "stream"
  // (see api.ts `layoutMode`), so that flow is unchanged.
  layout?: "full" | "stream";
  // Read-only embed: hide write affordances (delete, comment-as-owner, the
  // connect action). Orthogonal to `layout` — a host can have either without the
  // other. Self-hosted drives the same flag via window.__SIDESHOW_READONLY__.
  readonly?: boolean;
}

// Host-overridable surfaces. A handful of the engine's layout regions carry
// deployment-specific guidance (setup snippets, the connect flow, doc links) that
// only fits self-hosted sideshow. The engine wraps each such region in a
// `<slot name="...">` whose fallback content IS the self-hosted default — so a
// plain (host-less) embed and the self-hosted page look identical. An embedder
// (e.g. sideshow cloud) replaces a whole region by projecting a light-DOM child
// with a matching `slot=` attribute into the mount element.
//
// These are *regions*, not individual strings — keep the list small and coarse.
// Adding one is a deliberate contract change shared with every embedder.
export const SLOTS = {
  // Sidebar footer: design-guide / agent-setup links, the connect action, and the
  // theme picker. (`#onboard` aside, App.tsx)
  asideFoot: "ss:aside-foot",
  // Empty-board onboarding shown before any session exists. (`#onboard`, App.tsx)
  empty: "ss:empty",
  // Per-session actions in the session header, beside the stream/timeline toggle.
  // Empty by default (self-hosted has no actions here); an embedder projects
  // session-scoped controls such as a cloud "Share" button. (`.session-head`, App.tsx)
  sessionActions: "ss:session-actions",
} as const;

export type SlotName = (typeof SLOTS)[keyof typeof SLOTS];

type EngineRoot = Document | ShadowRoot;

let engineRoot: EngineRoot = document;
let injectedHost: SideshowHost | null = null;
let defaultHostCache: SideshowHost | null = null;

// Called once by mountViewer before <App/> renders, to point the engine at a
// shadow root + the embedder's host.
export function setEngine(root: EngineRoot, host: SideshowHost): void {
  engineRoot = root;
  injectedHost = host;
}

// The DOM root the engine queries/scopes to: `document` self-hosted, the shadow
// root when embedded. Both support querySelector/querySelectorAll/activeElement.
export function root(): EngineRoot {
  return engineRoot;
}

export function isShadow(): boolean {
  return engineRoot !== document;
}

// Where to append the engine's <style> nodes (theme palette): the <head> for a
// document, the shadow root itself when embedded.
export function styleContainer(): Node & ParentNode {
  return engineRoot instanceof Document ? engineRoot.head : engineRoot;
}

// The element carrying inherited theme vars / drawer class. Self-hosted that is
// <html> for vars and <body> for the drawer class (matching the existing
// `body.nav-open` rule); embedded it's the shadow host for both.
export function rootElement(): HTMLElement {
  return engineRoot instanceof Document
    ? engineRoot.documentElement
    : (engineRoot.host as HTMLElement);
}

// Element to toggle the mobile-drawer class on. Self-hosted: <body> (the CSS
// rule is `body.nav-open`). Embedded: the shadow host.
export function navHostEl(): HTMLElement {
  return engineRoot instanceof Document ? engineRoot.body : (engineRoot.host as HTMLElement);
}

// Element to read computed theme vars / fonts from. Self-hosted <body> inherits
// the :root vars AND carries the body font; embedded the shadow host carries the
// :host vars. (A document's <body> is the faithful probe for self-host parity.)
export function probeEl(): HTMLElement {
  return engineRoot instanceof Document ? engineRoot.body : (engineRoot.host as HTMLElement);
}

export function host(): SideshowHost {
  if (injectedHost) return injectedHost;
  return (defaultHostCache ??= createDefaultHost());
}

// Self-hosted default host: base path from the hosted-wrapper global / URL
// prefix (as the pre-engine viewer read it), routing over the History API with
// URL shapes identical to before (/session/:id and /session/:id/s/:sid).
export function createDefaultHost(): SideshowHost {
  const basePath =
    window.__SIDESHOW_BASE_PATH__ ?? location.pathname.match(/^\/u\/[^/]+/)?.[0] ?? "";
  const subs = new Set<(r: Route) => void>();

  const get = (): Route => {
    const rest = location.pathname.startsWith(basePath)
      ? location.pathname.slice(basePath.length)
      : location.pathname;
    const qSurface = new URLSearchParams(location.search).get("surface") ?? undefined;
    const m = rest.match(/^\/session\/([^/]+)(?:\/s\/([^/]+))?/);
    if (m) return { sessionId: m[1], surfaceId: m[2] ?? qSurface };
    return { surfaceId: qSurface };
  };

  const urlFor = (to: Route): string => {
    if (!to.sessionId) return basePath || "/";
    return to.surfaceId
      ? `${basePath}/session/${to.sessionId}/s/${to.surfaceId}`
      : `${basePath}/session/${to.sessionId}`;
  };

  const navigate = (to: Route, opts?: { replace?: boolean }): void => {
    const target = urlFor(to);
    if (opts?.replace) {
      history.replaceState(null, "", target);
    } else if (location.pathname !== target) {
      history.pushState(null, "", target);
    }
  };

  window.addEventListener("popstate", () => {
    const r = get();
    for (const cb of subs) cb(r);
  });

  return {
    basePath,
    router: {
      get,
      navigate,
      subscribe: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    },
  };
}

declare global {
  interface Window {
    __SIDESHOW_BASE_PATH__?: string;
  }
}

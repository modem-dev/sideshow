// Host-extension seam (generic, SaaS-agnostic).
//
// A wrapping deployment (e.g. a hosted SaaS) may want to render its own UI
// inside the viewer chrome — an account menu, a settings drawer — without
// forking the viewer. Shipping a second copy of Solid would break: compiled
// components must run on the *same* runtime instance that owns the viewer's
// reactive graph (the framework-independent "single runtime" rule). So instead
// of letting hosts bundle their own Solid, the viewer publishes its own runtime
// as a stable global and exposes a small registry. Host bundles target that
// global and register components into named slots; the viewer renders them
// inside its own root owner, so theme/context/signals are shared.
//
// Self-hosters never touch any of this: no slots are registered, the global is
// inert, and the chrome renders exactly as before.
import * as solid from "solid-js";
import * as solidWeb from "solid-js/web";
import * as solidStore from "solid-js/store";
import { Show } from "solid-js";
import type { Component } from "solid-js";
import { createStore } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import { activeTheme, setTheme, themeOptions } from "./theme.ts";
import { selected } from "./state.ts";
import { appBasePath } from "./api.ts";

// The minimal, read-only-ish context a host slot legitimately needs. Accessors
// are the viewer's own signals, so a host component that reads them re-renders
// with the chrome (e.g. follows theme changes). Deliberately small; widen only
// when a concrete host need appears.
export interface HostContext {
  /** Active theme id (reactive). */
  theme: () => string;
  /** Persist a new theme id board-wide (same control the ThemePicker uses). */
  setTheme: (id: string) => Promise<void> | void;
  /** Available themes as `{ id, label }`. */
  themes: () => { id: string; label: string }[];
  /** Id of the currently-selected session, or null (reactive). */
  activeSessionId: () => string | null;
  /** Public path prefix this viewer is mounted under (e.g. /u/alice), "" if root. */
  basePath: string;
}

const hostContext: HostContext = {
  theme: activeTheme,
  setTheme,
  themes: themeOptions,
  activeSessionId: selected,
  get basePath() {
    return appBasePath();
  },
};

// The stable runtime contract host bundles compile against. Over-expose on
// purpose: it is the single bundle's own Solid, so there is no cost to handing
// hosts the full API surface their compiled output may reference.
export interface SideshowSolidRuntime {
  web: typeof solidWeb;
  store: typeof solidStore;
  [key: string]: unknown;
}

const SOLID_RUNTIME: SideshowSolidRuntime = {
  ...solid,
  web: solidWeb,
  store: solidStore,
};

// Named chrome slots the viewer actually renders. Add a literal here only when a
// matching <Slot name="…"/> exists in the chrome — otherwise registering it would
// silently render nothing.
export type SlotName = "account";

// Reactive store of registrations, so a host bundle that registers *after* the
// viewer has booted (the common case — it loads as a deferred companion script)
// still renders: the matching <Slot> tracks this store and mounts on write.
const [registry, setRegistry] = createStore<Partial<Record<SlotName, Component<HostContext>>>>({});

/**
 * Register a host component into a named chrome slot. Last registration wins.
 * Safe to call before or after the viewer boots.
 */
export function registerSlot(name: SlotName, component: Component<HostContext>): void {
  // Solid's store setter treats a bare function argument as an updater and calls
  // it; pass `() => component` so the component is stored as the value, not invoked.
  setRegistry(name, () => component);
}

/** The context object exposed to slot components (also passed to them as props). */
export function getHostContext(): HostContext {
  return hostContext;
}

/**
 * Renders the host component registered for `name`, if any, inside the viewer's
 * own root owner. Empty (renders nothing) until a host registers — which is the
 * default for self-hosted deployments.
 */
export function Slot(props: { name: SlotName }) {
  return (
    <Show when={registry[props.name]}>
      {(component) => <Dynamic component={component()} {...hostContext} />}
    </Show>
  );
}

declare global {
  interface Window {
    __SIDESHOW_SOLID__?: SideshowSolidRuntime;
    sideshow?: {
      registerSlot: typeof registerSlot;
      getContext: typeof getHostContext;
    };
  }
}

// Publish the runtime + registry as early as this module evaluates (during the
// viewer's import graph, before render). Host bundles wait for `sideshow:ready`
// (dispatched by announceHostReady, post-render) before touching these, so the
// ordering is: viewer boots -> globals live -> ready event -> host registers.
window.__SIDESHOW_SOLID__ = SOLID_RUNTIME;
window.sideshow = { registerSlot, getContext: getHostContext };

/** Signal to host bundles that the runtime + registry are live. Called once, post-render. */
export function announceHostReady(): void {
  window.dispatchEvent(new CustomEvent("sideshow:ready"));
}

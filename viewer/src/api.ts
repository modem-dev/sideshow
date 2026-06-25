// Thin client over the REST API, typed against the server's data model.
import type {
  Comment,
  CodeSurface,
  DiffSurface,
  HtmlSurface,
  ImageSurface,
  JsonSurface,
  MarkdownSurface,
  MermaidSurface,
  Session,
  Post,
  Surface,
  TerminalSurface,
  TraceSurface,
  TraceStep,
} from "../../server/types.ts";
import { host } from "./host.ts";

export type {
  Comment,
  CodeSurface,
  DiffSurface,
  HtmlSurface,
  ImageSurface,
  JsonSurface,
  MarkdownSurface,
  MermaidSurface,
  Session,
  Post,
  Surface,
  TerminalSurface,
  TraceSurface,
  TraceStep,
};

export type PublicReadMode = "session" | "full";

// GET /api/sessions decorates each session with its surface count.
export interface SessionRow extends Session {
  surfaceCount: number;
}

// GET /api/version — upgradeCommand and notes are set only when an update
// is actually available.
export interface VersionInfo {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  upgradeCommand?: string | null;
  notes?: string | null;
}

declare global {
  interface Window {
    // __SIDESHOW_BASE_PATH__ lives in host.ts (the default host reads it).
    __SIDESHOW_READONLY__?: boolean;
    __SIDESHOW_PUBLIC_READ__?: PublicReadMode;
    __SIDESHOW_SCREENSHOTS__?: boolean;
  }
}

// The base path comes from the injected host (the default host derives it from
// the hosted-wrapper global / URL prefix, matching the pre-engine viewer).
export function appBasePath(): string {
  return host().basePath;
}

export function appPath(path: string): string {
  return `${appBasePath()}${path}`;
}

export function isReadonly(): boolean {
  // Host-first (cloud embed), falling back to the self-hosted global so the
  // self-hosted public-read page is byte-for-byte unchanged.
  return host().readonly ?? !!window.__SIDESHOW_READONLY__;
}

export function publicReadMode(): PublicReadMode | undefined {
  return window.__SIDESHOW_PUBLIC_READ__;
}

// The engine's layout. "full" shows the sidebar + stream; "stream" shows only
// the current session's stream (no sidebar/session list). An embedder requests
// it through the host; the self-hosted public-read "session" link maps to
// "stream", so that flow is unchanged with no host field set.
export function layoutMode(): "full" | "stream" {
  return host().layout ?? (publicReadMode() === "session" ? "stream" : "full");
}

export function surfaceLink(id: string): string {
  return `${location.origin}${appPath(`/s/${encodeURIComponent(id)}`)}`;
}

// The PNG screenshot of a surface (the same /s/:id page, captured server-side).
// Only reachable where `canScreenshot()` is true — see that helper.
export function surfaceImageLink(id: string): string {
  return `${location.origin}${appPath(`/s/${encodeURIComponent(id)}.png`)}`;
}

// Whether the deployment can render surface screenshots (the /s/:id.png route).
// Host-first (cloud embed), falling back to the self-hosted global, mirroring
// isReadonly(). False on a plain Node server, which has no Browser Rendering.
export function canScreenshot(): boolean {
  return host().screenshots ?? !!window.__SIDESHOW_SCREENSHOTS__;
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(
    appPath(path),
    init ? { headers: { "content-type": "application/json" }, ...init } : undefined,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || String(res.status));
  }
  return res.json() as Promise<T>;
}

export const sessionLabel = (s: Session) => s.title || s.agent + " session";

export function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

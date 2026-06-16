// Thin client over the REST API, typed against the server's data model.
import type {
  Comment,
  DiffPart,
  HtmlPart,
  ImagePart,
  MarkdownPart,
  Session,
  Surface,
  SurfacePart,
  TerminalPart,
  TracePart,
  TraceStep,
} from "../../server/types.ts";

export type {
  Comment,
  DiffPart,
  HtmlPart,
  ImagePart,
  MarkdownPart,
  Session,
  Surface,
  SurfacePart,
  TerminalPart,
  TracePart,
  TraceStep,
};

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

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(
    path,
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

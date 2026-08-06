// Host-side policy for messages sandboxed surfaces post to whatever embeds them.
// Two hosts implement that bridge — the live viewer (viewer/src/App.tsx,
// Card.tsx) and the static session export's shell script (exportPage.ts) — and
// they can't share an implementation: one is bundled TypeScript, the other is a
// plain-JS string baked into a saved file. So they share the POLICY here, and
// the export interpolates these values into its script instead of restating
// them. Runtime-agnostic (no DOM, no `node:`) so the Worker DO can import it.
//
// The policy matters because both decisions are security boundaries: the frame
// is untrusted, so it can post any `open-link` url (javascript:, data:, file:)
// or any `resize` height it likes.
import { MAX_FRAME_H, MIN_FRAME_H } from "./types.ts";

// Only real external navigations are ever opened. A contained script can call
// openLink() directly — or post the message raw — with any scheme, so the host
// re-checks rather than trusting the in-frame click handler's filtering.
export const EXTERNAL_LINK_PROTOCOLS: readonly string[] = ["http:", "https:"];

// The request comes from untrusted content, so a disguised control could
// otherwise silently open any page. Both hosts show the NORMALIZED destination
// and let the reader decide.
export const OPEN_LINK_PROMPT = "Open external link?\n\n";

// Parse once and return the normalized href, so there's no gap between the
// string that was validated and the string that gets opened (window.open would
// otherwise re-parse). null means "reject": unparseable, or a scheme outside the
// allowlist.
export function externalLinkHref(raw: unknown): string | null {
  let link: URL;
  try {
    link = new URL(String(raw));
  } catch {
    return null;
  }
  return EXTERNAL_LINK_PROTOCOLS.includes(link.protocol) ? link.href : null;
}

// Clamp a bridge-reported iframe height: min one line, max generous enough for a
// long diff or markdown surface without runaway growth. NaN floors to the
// minimum rather than producing "NaNpx".
export function clampFrameHeight(reported: unknown): number {
  return Math.min(Math.max(Number(reported) || MIN_FRAME_H, MIN_FRAME_H), MAX_FRAME_H);
}

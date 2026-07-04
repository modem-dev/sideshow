// The built-in welcome/test post — the fixed card `send_test_post` (MCP),
// `POST /api/test-post` (REST), and `sideshow test-post` (CLI) publish.
//
// Why fixed content: a newly connected agent's first post is the user's first
// impression of the whole product, and leaving it to the agent to improvise is
// a quality lottery. Shipping the card with sideshow makes the first post
// deterministic — it confirms the connection is live, shows what a good card
// looks like, and hands the user concrete prompts that reliably produce real
// posts. The content is versioned with sideshow itself, not authored per call.
//
// Idempotency: publishing is guarded by findWelcomePost — a second call finds
// the existing card (by its fixed title) and returns it instead of stacking
// welcome posts. If the user deleted or retitled it, a fresh one is published;
// that matches intent (they asked for a test post and don't have one).
import { htmlSurface, type Post, type Store, type Surface } from "./types.ts";

export const WELCOME_POST_TITLE = "👋 Your agent is connected";
export const WELCOME_SESSION_TITLE = "Getting started";

// One composed html surface. Styled entirely from the viewer's theme variables
// (never hardcoded colors) so it reads correctly in light and dark; fallback
// values inside var() keep it legible if a token is ever renamed.
const WELCOME_HTML = `
<div style="font-family:var(--font-sans);padding:8px 4px">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
    <span style="width:10px;height:10px;border-radius:50%;background:var(--color-text-success,#3fb950);box-shadow:0 0 0 4px color-mix(in srgb, var(--color-text-success,#3fb950) 20%, transparent)"></span>
    <span style="font-size:13px;color:var(--color-text-secondary);letter-spacing:.06em;text-transform:uppercase">Connected</span>
  </div>
  <h1 style="margin:0 0 8px;font-size:26px;line-height:1.2">Your agent can draw here now.</h1>
  <p style="margin:0 0 20px;font-size:14px;color:var(--color-text-secondary);max-width:52ch">
    sideshow is a live surface your agents draw on while they work &mdash; posts land here
    instantly as cards.
  </p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:24px">
    <div style="background:var(--color-background-secondary);border-radius:var(--border-radius-lg);padding:14px">
      <div style="font-size:20px;margin-bottom:6px">🗺️</div>
      <strong style="font-size:13px">Diagrams</strong>
      <div style="font-size:12px;color:var(--color-text-tertiary)">html &amp; mermaid</div>
    </div>
    <div style="background:var(--color-background-secondary);border-radius:var(--border-radius-lg);padding:14px">
      <div style="font-size:20px;margin-bottom:6px">🔍</div>
      <strong style="font-size:13px">Code reviews</strong>
      <div style="font-size:12px;color:var(--color-text-tertiary)">native diff cards</div>
    </div>
    <div style="background:var(--color-background-secondary);border-radius:var(--border-radius-lg);padding:14px">
      <div style="font-size:20px;margin-bottom:6px">📝</div>
      <strong style="font-size:13px">Plans &amp; prose</strong>
      <div style="font-size:12px;color:var(--color-text-tertiary)">rendered markdown</div>
    </div>
    <div style="background:var(--color-background-secondary);border-radius:var(--border-radius-lg);padding:14px">
      <div style="font-size:20px;margin-bottom:6px">📟</div>
      <strong style="font-size:13px">Logs &amp; data</strong>
      <div style="font-size:12px;color:var(--color-text-tertiary)">terminal, json, traces</div>
    </div>
  </div>
  <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-tertiary);margin-bottom:10px">Try asking your agent</div>
  <div style="display:flex;flex-direction:column;gap:8px">
    <div style="border:1px solid var(--color-border-tertiary);border-radius:var(--border-radius-md);padding:10px 14px;font-size:13.5px">&ldquo;Draw a diagram of this codebase's architecture and post it to sideshow.&rdquo;</div>
    <div style="border:1px solid var(--color-border-tertiary);border-radius:var(--border-radius-md);padding:10px 14px;font-size:13.5px">&ldquo;Post a code review of the change you just made.&rdquo;</div>
    <div style="border:1px solid var(--color-border-tertiary);border-radius:var(--border-radius-md);padding:10px 14px;font-size:13.5px">&ldquo;Sketch two layout options for this page so I can compare.&rdquo;</div>
    <div style="border:1px solid var(--color-border-tertiary);border-radius:var(--border-radius-md);padding:10px 14px;font-size:13.5px">&ldquo;Explain the auth flow with a sequence diagram.&rdquo;</div>
    <div style="border:1px solid var(--color-border-tertiary);border-radius:var(--border-radius-md);padding:10px 14px;font-size:13.5px">&ldquo;Post the failing test output and what you think is wrong.&rdquo;</div>
  </div>
  <p style="margin:20px 0 0;font-size:12px;color:var(--color-text-tertiary)">
    Sent by <code style="font-family:var(--font-mono)">send_test_post</code> &mdash; fixed content, versioned with sideshow itself.
  </p>
</div>
`.trim();

// Fresh array per call — publish paths may tag/mutate surface objects (ids),
// so callers must never share one instance.
export function welcomeSurfaces(): Surface[] {
  return [htmlSurface(WELCOME_HTML)];
}

// The idempotency probe: the existing welcome post, or null. Matched by the
// fixed title — the card has no other stable marker, and a user who retitled
// it has made it their own (a fresh test post is then correct, not a dupe).
export async function findWelcomePost(store: Store): Promise<Post | null> {
  const posts = await store.listPosts();
  return posts.find((p) => p.title === WELCOME_POST_TITLE) ?? null;
}

// Session HTML export — render a whole session into ONE self-contained,
// shareable HTML document. Runtime-agnostic (no `node:` imports, no DOM
// globals) so the Worker DO serves it too; enforced via the app.ts import chain
// under tsconfig.workers.json.
//
// The core isolation rule holds INSIDE the exported file, opened from disk on a
// teammate's machine where no server serves /s/:id: every surface that becomes
// HTML is rendered with the EXACT same sandboxed-document dispatch /s/:id
// serves (renderSurfaceDocument), then embedded as
// `<iframe sandbox="allow-scripts" srcdoc="...">`. The srcdoc value is
// attribute-escaped (escapeHtml escapes quotes), so hostile surface markup stays
// inert. The shell itself is a trusted document (like the viewer): agent content
// only ever lives inside sandbox-attributed iframes, never as innerHTML here.
// image/json/trace surfaces are DATA rendered via escaping (the "(b)" path), so
// they need no iframe.

import type { Asset, Comment, Post, Session, Surface } from "./types.ts";
import {
  INLINE_IMAGE_TYPES,
  isSandboxedSurfaceKind,
  MAX_FRAME_H,
  MIN_FRAME_H,
  SURFACE_FRAME_CLASSES,
} from "./types.ts";
import { encodeBase64 } from "./base64.ts";
import { CARD_CHROME_CSS } from "./cardChrome.ts";
import { colorSchemeCss, escapeHtml, renderSurfaceDocument } from "./surfacePage.ts";
import { type Mode, type Theme, themeById, viewerThemeCss } from "./themes.ts";

interface ExportContext {
  origin: string;
  themeId: string;
  mode?: Mode;
  // Resolve an uploaded asset's bytes so image surfaces can be inlined as data:
  // URIs (a self-contained file has no server to serve /a/:id).
  getAsset: (id: string) => Promise<Asset | null>;
  // Aggregate budget for inlined asset bytes, decremented as image surfaces
  // render. The workspace asset budget (MAX_WORKSPACE_ASSET_BYTES) is 2 GB, so
  // without a per-export cap a screenshot-heavy session could balloon the
  // document past Worker/Node memory — and on a publicRead workspace the export
  // route does that work unauthenticated. Images past the budget degrade to a
  // note, same as a missing asset.
  assetBytesRemaining: number;
  // Per-export memo of already-resolved assets: a session can reference the same
  // asset from many image surfaces, and without this each reference re-fetches
  // (a full byte clone in JsonFileStore, a full blob SELECT in SqlStore) and
  // re-encodes megabytes of base64. Rejections are memoized too — a missing or
  // non-image asset referenced N times costs N fetches otherwise, and surface
  // COUNT is unbounded (only per-post and per-session TEXT bytes are capped), so
  // one cheap write could otherwise make every export re-read the same 5 MB blob
  // hundreds of thousands of times. Each rendered copy still charges the byte
  // budget — every inline duplicate really is duplicated in the output.
  inlinedAssets: Map<string, { byteLength: number; dataUri: string } | { rejected: string }>;
}

// Default inline-asset budget per export. A Workers isolate has ~128 MB of
// memory and base64 inflates bytes by 4/3, with the shell assembly briefly
// holding another copy — 32 MB raw (~43 MB encoded) keeps peak usage well under
// that ceiling while still fitting hundreds of typical screenshots.
const MAX_EXPORT_ASSET_BYTES = 32 * 1024 * 1024;

// Aggregate cap on a session's surface TEXT bytes, checked by the route before
// rendering (per-post text is capped at 2 MB, post count isn't). Rendered
// output inflates input hard: syntax highlighting wraps tokens in styled spans
// and srcdoc embedding then entity-escapes the whole document, so dense code
// can grow ~10×+. 4 MB of input keeps the assembled document within a Workers
// isolate's ~128 MB alongside the MAX_EXPORT_ASSET_BYTES image budget, and is
// still far past any real session's text.
export const MAX_EXPORT_SURFACE_BYTES = 4 * 1024 * 1024;

// Wrap a sandboxed document string in the srcdoc iframe the shell sizes via the
// bridge. `frameClass` mirrors the viewer's per-kind hook (mdframe/diffframe/…)
// — a styling and test-selector hook; html surfaces have none.
function frame(doc: string, frameClass?: string): string {
  const cls = frameClass ? `ss-frame ${frameClass}` : "ss-frame";
  return `<iframe class="${cls}" sandbox="allow-scripts" srcdoc="${escapeHtml(doc)}"></iframe>`;
}

// Render one surface to the HTML fragment that sits inside a card body. Sandboxed
// kinds become srcdoc iframes of the same documents /s/:id serves; native kinds
// (image/json/trace) become escaped, data-only markup. `postTitle` names the
// html-surface document (matches renderPostPage passing post.title).
async function exportSurface(
  surface: Surface,
  ctx: ExportContext,
  postTitle: string,
): Promise<string> {
  if (isSandboxedSurfaceKind(surface.kind)) {
    const doc = await renderSurfaceDocument(surface, {
      title: postTitle,
      origin: ctx.origin,
      themeId: ctx.themeId,
      mode: ctx.mode,
      // srcdoc's base is about:srcdoc, so an html surface's relative /a/:id
      // refs would break; pin the base to the origin (works only for readers
      // with access to it — documented portability boundary). Only html
      // surfaces consume this; the rich kinds pin <base> themselves.
      baseHref: `${ctx.origin}/`,
    });
    return frame(doc, SURFACE_FRAME_CLASSES[surface.kind]);
  }

  if (surface.kind === "image") {
    const note = (msg: string) =>
      `<p class="ss-note">Image asset <code>${escapeHtml(surface.assetId)}</code> ${msg}</p>`;
    // Memoized rejection: terminal for this export, so no refetch. The size
    // limit is NOT memoized here — it depends on the remaining budget, which
    // shrinks as other images inline, so it's re-checked per reference below.
    const reject = (msg: string) => {
      ctx.inlinedAssets.set(surface.assetId, { rejected: msg });
      return note(msg);
    };
    let inlined = ctx.inlinedAssets.get(surface.assetId);
    if (inlined && "rejected" in inlined) return note(inlined.rejected);
    if (!inlined) {
      const asset = await ctx.getAsset(surface.assetId);
      if (!asset) return reject("is no longer available.");
      // contentType is upload-controlled and this <img> lives in the trusted
      // shell, so only the raster allowlist may reach the data: URI — a crafted
      // type could otherwise smuggle markup into the attribute or a scriptable
      // document (svg) into the shell. Escaped like every other attribute even
      // though the allowlisted URI is inert, so safety doesn't hinge on the list.
      if (!INLINE_IMAGE_TYPES.has(asset.contentType)) {
        return reject("has a non-image content type and was omitted.");
      }
      // Budget-checked BEFORE encoding: an over-budget asset must never be
      // encoded or memoized, or N distinct oversized assets could accumulate
      // encodings the budget was supposed to bound.
      if (asset.data.byteLength > ctx.assetBytesRemaining) {
        return note("omitted — this export reached its inline-image size limit.");
      }
      inlined = {
        byteLength: asset.data.byteLength,
        dataUri: `data:${asset.contentType};base64,${encodeBase64(asset.data)}`,
      };
      ctx.inlinedAssets.set(surface.assetId, inlined);
    } else if (inlined.byteLength > ctx.assetBytesRemaining) {
      return note("omitted — this export reached its inline-image size limit.");
    }
    ctx.assetBytesRemaining -= inlined.byteLength;
    const alt = escapeHtml(surface.alt ?? "");
    const caption = surface.caption
      ? `<figcaption class="ss-caption">${escapeHtml(surface.caption)}</figcaption>`
      : "";
    return `<figure class="ss-image"><img src="${escapeHtml(inlined.dataUri)}" alt="${alt}">${caption}</figure>`;
  }

  if (surface.kind === "json") {
    // Safe path (b): data escaped by construction. `?? "null"` guards the JS
    // `undefined` JSON.stringify can return, so escapeHtml never sees undefined.
    const text = JSON.stringify(surface.data, null, 2) ?? "null";
    return `<pre class="ss-json">${escapeHtml(text)}</pre>`;
  }

  // trace: experimental kind stays out of the product surface (CLAUDE.md).
  // Honest-but-omitted beats silently dropping it.
  return `<p class="ss-note">Trace surface omitted from export.</p>`;
}

interface RenderedPost {
  post: Post;
  comments: Comment[];
  surfaces: string[];
}

// The shell script: the postMessage bridge (resize / open-link / copy) plus the
// per-iframe Chrome-149 srcdoc re-parse retry ported from commit 5e3f292. No
// agent behind a static file, so send-prompt/switch-session are dropped.
const SHELL_JS = `
(function () {
  var MIN = ${MIN_FRAME_H}, MAX = ${MAX_FRAME_H};
  function frameFor(source) {
    var frames = document.querySelectorAll('iframe.ss-frame');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === source) return frames[i];
    }
    return null;
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__sideshow !== true) return;
    // Attribute every message to a frame we actually embedded (contentWindow
    // identity holds across the opaque-origin boundary) — the export's
    // isOwnFrame. A frame can only ever resize itself.
    var frame = frameFor(e.source);
    if (!frame) return;
    if (d.type === 'resize') {
      frame.style.height = Math.min(Math.max(Number(d.height) || MIN, MIN), MAX) + 'px';
    } else if (d.type === 'open-link') {
      var url;
      try { url = new URL(String(d.url)); } catch (err) { return; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      // Same confirmation as the viewer (App.tsx): the request comes from an
      // untrusted frame, so a disguised control could silently open any page —
      // show the normalized destination and let the reader decide.
      if (window.confirm('Open external link?\\n\\n' + url.href)) {
        window.open(url.href, '_blank', 'noopener,noreferrer');
      }
    } else if (d.type === 'copy') {
      if (navigator.clipboard) navigator.clipboard.writeText(String(d.text)).catch(function () {});
    }
    // send-prompt / switch-session: no-ops — a static file has no agent behind it.
  });
  // Chrome 149 field trial breaks layout measurement in opaque-origin srcdoc
  // iframes (scrollHeight/offsetHeight read 0), so the bridge reports only body
  // padding and the frame sticks at min height. Re-setting srcdoc forces a
  // re-parse that recovers layout; a no-op in unaffected browsers. (Ported from
  // viewer/src/SandboxedPart.tsx at commit 5e3f292.)
  var pending = document.querySelectorAll('iframe.ss-frame');
  for (var i = 0; i < pending.length; i++) {
    (function (frame) {
      setTimeout(function () {
        if (frame.offsetHeight > MIN) return;
        var doc = frame.getAttribute('srcdoc');
        if (doc == null) return;
        frame.removeAttribute('srcdoc');
        requestAnimationFrame(function () { frame.setAttribute('srcdoc', doc); });
      }, 2000);
    })(pending[i]);
  }
})();
`;

// The shell's own chrome. The card column itself (container/head/title/meta) is
// the SAME rules the live viewer injects — CARD_CHROME_CSS (server/cardChrome.ts)
// over the derived theme vars — so the saved file tracks the real look instead of
// drifting behind a copy; the rules below only adapt it to a static document and
// style the export-only bits. No load-restricting CSP: srcdoc children inherit
// the parent document's CSP, so a policy here would break the CDN loads
// html/mermaid frames need.
function shellCss(theme: Theme, mode?: Mode): string {
  return `
${viewerThemeCss(theme, mode)}
${colorSchemeCss(mode)}
${CARD_CHROME_CSS}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 16px 64px;
  background: var(--bg); color: var(--text);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.ss-shell { max-width: 820px; margin: 0 auto; }
.ss-header { margin: 0 0 24px; }
.ss-header h1 { font-size: 1.4em; margin: 0 0 4px; font-weight: 600; }
.ss-header .ss-sub { color: var(--muted); font-size: 0.85em; }
.card-head { justify-content: space-between; }
.card-head .card-title { margin: 0; }
.card-meta { white-space: nowrap; }
.ss-frame { display: block; width: 100%; border: 0; border-top: 0.5px solid var(--border); height: ${MIN_FRAME_H}px; }
.ss-image { margin: 0; padding: 16px; border-top: 0.5px solid var(--border); }
.ss-image img { max-width: 100%; height: auto; border-radius: 8px; display: block; }
.ss-caption { color: var(--muted); font-size: 0.85em; margin-top: 8px; }
.ss-json {
  margin: 0; padding: 14px 16px; overflow: auto; white-space: pre; border-top: 0.5px solid var(--border);
  color: var(--text); font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.ss-note { margin: 0; padding: 14px 16px; border-top: 0.5px solid var(--border); color: var(--muted); font-size: 0.9em; font-style: italic; }
.ss-thread { border-top: 0.5px solid var(--border); padding: 8px 16px 12px; }
.ss-comment { padding: 8px 0; }
.ss-comment + .ss-comment { border-top: 0.5px solid var(--border); }
.ss-comment .ss-comment-head { display: flex; gap: 8px; align-items: baseline; margin-bottom: 2px; }
.ss-comment .ss-author { font-weight: 600; font-size: 0.85em; }
.ss-comment .ss-time { color: var(--faint); font-size: 0.75em; }
.ss-comment p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.ss-empty { color: var(--muted); font-style: italic; }
`;
}

function commentThread(comments: Comment[]): string {
  if (comments.length === 0) return "";
  const rows = comments
    .map(
      (c) =>
        `<div class="ss-comment"><div class="ss-comment-head"><span class="ss-author">${escapeHtml(
          c.author === "user" ? "you" : c.author,
        )}</span><span class="ss-time">${escapeHtml(c.createdAt)}</span></div><p>${escapeHtml(
          c.text,
        )}</p></div>`,
    )
    .join("");
  return `<section class="ss-thread">${rows}</section>`;
}

function card(item: RenderedPost): string {
  const meta = `v${item.post.version} · ${escapeHtml(item.post.createdAt)}`;
  const body = item.surfaces.join("\n");
  return `<article class="card">
<header class="card-head"><h2 class="card-title">${escapeHtml(item.post.title)}</h2><span class="card-meta">${meta}</span></header>
<div class="ss-surfaces">${body}</div>
${commentThread(item.comments)}
</article>`;
}

// The trusted shell string. Pure/sync — the surfaces are already rendered by
// exportSurface (async), so this only assembles escaped/attribute-safe markup.
function renderSessionExportPage(opts: {
  session: Session;
  items: RenderedPost[];
  theme: Theme;
  mode?: Mode;
  generatedAt: string;
}): string {
  const { session, items } = opts;
  const heading =
    session.title || (session.agent ? `${session.agent} session` : "sideshow session");
  const cards =
    items.length > 0
      ? items.map(card).join("\n")
      : `<p class="ss-empty">This session has no posts yet.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)} · sideshow</title>
<style>${shellCss(opts.theme, opts.mode)}</style>
</head>
<body>
<main class="ss-shell">
<header class="ss-header">
<h1>${escapeHtml(heading)}</h1>
<div class="ss-sub">Exported from sideshow · ${escapeHtml(opts.generatedAt)}</div>
</header>
${cards}
</main>
<script>${SHELL_JS}</script>
</body>
</html>`;
}

// Orchestrator the route calls: resolve every surface (async renderers) and
// assemble the trusted shell. Kept here so app.ts stays thin and the whole
// export path is one runtime-agnostic module.
export async function renderSessionExport(opts: {
  session: Session;
  items: { post: Post; comments: Comment[] }[];
  origin: string;
  themeId: string;
  mode?: Mode;
  generatedAt: string;
  getAsset: (id: string) => Promise<Asset | null>;
  // Inline-asset budget override, for embedders and tests; defaults to
  // MAX_EXPORT_ASSET_BYTES.
  maxInlineAssetBytes?: number;
}): Promise<string> {
  const ctx: ExportContext = {
    origin: opts.origin,
    themeId: opts.themeId,
    mode: opts.mode,
    getAsset: opts.getAsset,
    assetBytesRemaining: opts.maxInlineAssetBytes ?? MAX_EXPORT_ASSET_BYTES,
    inlinedAssets: new Map(),
  };
  // Sequential on purpose: rendering is CPU-bound on a single-threaded runtime,
  // so Promise.all buys no wall-clock — it only holds every post's decoded
  // assets and intermediate strings in memory at once. Sequencing bounds peak
  // memory to one surface in flight (plus the accumulated output, which the
  // asset budget caps) and makes budget accounting deterministic in document
  // order.
  const rendered: RenderedPost[] = [];
  for (const item of opts.items) {
    const surfaces: string[] = [];
    for (const s of item.post.surfaces) {
      surfaces.push(await exportSurface(s, ctx, item.post.title));
    }
    rendered.push({ post: item.post, comments: item.comments, surfaces });
  }
  return renderSessionExportPage({
    session: opts.session,
    items: rendered,
    theme: themeById(opts.themeId),
    mode: opts.mode,
    generatedAt: opts.generatedAt,
  });
}

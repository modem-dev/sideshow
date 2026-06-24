# Rich-part rendering: spike plan + context

> Working/handoff doc. Not part of the shippable PR — delete or gitignore before merge.
> Branch: `fix/rich-parts-blob-url` (PR #125). Written 2026-06-24.

## TL;DR

We set out to fix rich parts (markdown/diff/terminal/mermaid/code + comments)
rendering blank/clipped on reload under a Chrome 149 field trial. The fix that
**currently works and is committed in PR #125** serves each rich part's rendered
HTML from a real URL (`/f/:id`) with a `sandbox` CSP header, instead of an
in-memory `srcdoc`/`blob:` document. It keeps full opaque-origin isolation and is
confirmed working on the affected Chrome 149 profile.

But that introduced a `POST /api/frames` endpoint + a transient server store +
a public-read auth exception — and surfaced a pre-existing perf problem (the
viewer is a 12.7 MB single-file inlined-JS bundle). We've decided to **pivot to
rendering rich parts server-side** and serve them all from `/s/:id` like html
parts, deleting the `POST`/`/f/:id` path. This also shrinks the client bundle.

**Next action: run the spike below** to confirm shiki + @pierre/diffs can render
under the runtime-agnostic / Cloudflare Workers constraint, _before_ tearing out
the `/f/:id` path.

---

## The bug (root cause)

A Chrome 149 field trial defers layout in **opaque-origin _in-memory_ iframe
documents** (`srcdoc` and `blob:`). The resize bridge measures `scrollHeight` as
`0`, so the frame stays collapsed and the part renders blank — non-deterministic
per reload. The async-rendered parts (diff via @pierre SSR, mermaid via
`await mermaid.render`) are worst: they render empty first, then a second load
that never lays out, so they **never** appear.

**Key learning — the trigger is the in-memory document, NOT opaque origin.**
Proof: html parts at `/s/:id` are _also_ opaque-origin (via a `sandbox` CSP
response header) but were never affected, because they load by **real HTTP
navigation**. So: real-URL doc + sandbox header = opaque origin that lays out
normally. (#101's `allow-same-origin` approach mis-diagnosed this as
opaque-origin-in-general and traded away isolation to fix it.)

## What we tried (chronological)

1. **#101 (not ours): `sandbox="allow-scripts allow-same-origin"` + CSP nonce.**
   Makes rich frames same-origin with the board → collapses defense-in-depth to a
   single nonce boundary; a running script could reach `parent.fetch`/`parent.document`.
   Rejected on security grounds (rewrites the core "never weaken" invariant).
2. **`blob:` URL (kept opaque origin).** Still an in-memory document → diff/mermaid
   never load on the affected profile. Rejected. (Superseded commits still in branch
   history; net diff is the `/f/:id` approach.)
3. **`/f/:id` sandbox-header (CURRENT, committed).** Viewer POSTs the rendered
   string to `/api/frames`; `/f/:id` serves it with `Content-Security-Policy:
sandbox allow-scripts`. Real URL → dodges the bug; opaque origin → isolation
   intact. **Confirmed working on Chrome 149.** Downsides that triggered the pivot:
   a write endpoint, a transient store, a public-read POST exception, no caching.

## Other key learnings

- **Rich-part CSP allows `'unsafe-inline'`** (so the bridge runs without a nonce).
  Therefore the **opaque origin is the ONLY thing containing a script** in a rich
  frame. Any approach must keep rich content opaque-origin. The e2e isolation test
  asserts a script that _runs_ in the frame can't read its origin or write the parent.
- **Perf (pre-existing, NOT caused by this PR):** the self-hosted viewer is built
  by `vite-plugin-singlefile` into one `viewer/dist/index.html` that is **12.7 MB,
  99.9% inline JS**, served **uncompressed**. Brutal initial/uncached fetch
  (~5.6 s to hornet). The source already code-splits (mermaid/katex/shiki are
  `await import()`ed) but singlefile re-inlines it all. Server-side rendering would
  pull shiki/markdown-it/@pierre out of the client bundle — fixing this too.
- **No server-side mermaid renderer is viable.** Mermaid needs a DOM (d3/SVG);
  only `@mermaid-js/mermaid-cli` (Puppeteer) or jsdom — both heavy, Node-only, not
  Workers. So mermaid stays client-rendered, inside a server-emitted sandboxed doc
  that loads mermaid JS (CDN) — reusing the html-part CDN/kit machinery.

## Current PR #125 state

Branch `fix/rich-parts-blob-url`. Net diff vs `main` = the `/f/:id` approach.

- `server/app.ts`: `POST /api/frames` (bounded FIFO `frameDocs` map, `MAX_FRAME_DOCS=512`),
  `GET /f/:id` (serves with `sandbox allow-scripts` + `nosniff`), `/f/` added to
  `isPublicReadAllowed`, POST-public-read exception in auth middleware. `newId` imported.
- `viewer/src/SandboxedPart.tsx`: POSTs doc → sets `frame.src = appPath('/f/'+id)`
  with a seq guard. (Was srcdoc, then blob, now `/f/:id`.)
- `test/api.test.ts`: 3 tests (frames stage/serve+headers/404/400; public-read reachable; auth required).
- `e2e/isolation.spec.ts`: rewritten test proves `/f/:id` is opaque + carries the sandbox header.
- `AGENTS.md`: note about `/f/:id` load path. `.changeset/rich-parts-render-url.md`.
- Validation: `npm test` 208/208, chromium e2e green, typecheck/lint/format clean.
  WebKit e2e NOT run (host missing `libicu74` etc.). Confirmed on Chrome 149 profile.

**If the pivot lands, most of the above gets removed** (POST/`/f/:id`/store/exception),
replaced by extending `/s/:id` to rich kinds. Decide whether to keep #125 as the
interim fix or fold the refactor into it.

## Target architecture (the pivot)

Serve **every** part from `/s/:id?part=N` (real URL + `sandbox` header), like html
parts already do. Viewer part components become thin iframes pointing there.

- markdown / terminal / code / diff → **server-rendered HTML** at `/s/:id`.
- mermaid → server emits a **self-rendering sandboxed doc** (loads mermaid from CDN).
- comments → server-rendered escaped text.
- Delete `POST /api/frames` + `/f/:id` + store + auth exception.
- Wins: no write endpoint, cacheable (`?ver=`), smaller client bundle.

**Important fallback insight:** the "emit a sandboxed self-rendering doc at `/s/:id`
that loads the renderer from CDN" trick (the mermaid plan) works for **any**
renderer that can't run on Workers. So there are two viable end-states, and the
spike picks per-renderer:

- **(A) True server-side render** — smallest payload, cacheable HTML; needs the
  lib to run on the Worker DO.
- **(B) Self-rendering sandboxed doc** — lib loads in-iframe from CDN; no Workers
  renderer needed; still real-URL `/s/:id` (no POST, dodges the bug). Mermaid uses (B).

Either end-state removes the POST and keeps opaque-origin isolation.

## The spike (de-risk before refactor)

Goal: determine whether shiki and @pierre/diffs can render under
`tsconfig.workers.json` (runtime-agnostic, no `node:` imports) and at runtime on
the Worker DO. markdown-it and ansi_up are pure JS (low risk).

Steps:

1. Create `server/richRender.ts` (runtime-agnostic) with
   `renderMarkdown/renderTerminal/renderCode/renderDiff(part, {theme, mode}) → {body, css}`,
   porting logic + CSS strings from `viewer/src/{MarkdownPart,TerminalPart,CodePart,DiffPart}.tsx`.
2. Confirm it typechecks under **all three** tsc programs, especially
   `tsconfig.workers.json` (add `server/richRender.ts` to the workers-agnostic set).
3. **shiki on Workers**: use the JS regex engine (`createJavaScriptRegexEngine`
   from `shiki/engine/javascript`) to avoid wasm/oniguruma, or load wasm explicitly.
   Render a code block; confirm no `node:`/wasm-fetch blockers.
4. **@pierre/diffs SSR**: import its SSR API in that program; render a patch; confirm
   it runs without a DOM.
5. Verdict per renderer: (A) server-render if clean, else (B) self-rendering doc.
   mermaid is (B) regardless.

If shiki/@pierre fight Workers → don't force server-render; use (B) for them
(emit a `/s/:id` doc that loads the lib from CDN and renders in the sandboxed
iframe). Still removes the POST and serves from a real URL.

## SPIKE RESULT — DONE 2026-06-24: all four render server-side (A). ✅

`server/richRender.ts` is written and committed-to-branch (untracked, not in a
commit yet) with `renderMarkdown/renderTerminal/renderCode/renderDiff(part,
{theme, mode}) → {body, css}`, ported from the viewer parts. It is **not yet
wired into any route** — it's the spike artifact the refactor will consume.

Four independent signals all green:

1. **Typecheck** — `server/richRender.ts` added to `tsconfig.workers.json`
   include; `npm run typecheck` (node + workers + viewer) passes. shiki,
   `shiki/engine/javascript`, `@pierre/diffs`, `@pierre/diffs/ssr`, `markdown-it`,
   `ansi_up` all resolve and typecheck under workers types.
2. **Node runtime** — each renderer executed (no DOM): markdown emits a
   `class="shiki"` fenced block, terminal collapses CRs, code applies the
   `counter-reset:line` start, diff produces ~50KB of @pierre SSR
   (`diffs-container` + declarative shadow roots).
3. **Clean workerd bundle** — `esbuild --platform=browser
--conditions=workerd,worker,browser` bundles it with **zero `node:` builtins**
   and zero real `require()` (the one match was a Ruby TextMate grammar regex).
4. **Real workerd execution** — ran the four renderers inside `wrangler dev` on
   workerd via a throwaway worker; all returned `ok:true` (`allOk:true`),
   including the heavy @pierre SSR diff. So no runtime-global gap either.

**Verdict per renderer:**

- markdown → **(A) server-render** ✅ (markdown-it + shiki-js)
- terminal → **(A) server-render** ✅ (ansi_up, pure JS)
- code → **(A) server-render** ✅ (shiki-js)
- diff → **(A) server-render** ✅ (@pierre/diffs SSR on `preferredHighlighter:
"shiki-js"`)
- mermaid → **(B) self-rendering sandboxed doc** (unchanged; needs a DOM, loads
  mermaid from CDN inside the `/s/:id` iframe).

Best-case outcome: the pivot is fully de-risked, no (B) fallback needed for the
text renderers. **The refactor (extend `/s/:id` to rich kinds, delete
`POST /api/frames` + `/f/:id` + store + auth exception) is cleared to start.**

Notes for the refactor:

- shiki/markdown-it/mermaid are currently **devDependencies** (viewer-bundled).
  Once `richRender.ts` is imported by server/workers runtime code they must move
  to **dependencies** (Node server needs them at runtime; wrangler bundles them
  into the DO). `@pierre/diffs` + `ansi_up` are already deps.
- The Worker bundle absorbs shiki (~10MB of grammars when fully inlined) — but
  that's server-side; the **client** bundle shrinks (shiki/markdown-it/@pierre
  leave the viewer), which is the perf win the doc wanted. Confirm shiki langs
  still load on-demand under wrangler's bundler (dynamic `import()` of grammars),
  or accept the inlined set.
- `richRender.ts` duplicates `shikiSchemeCss` and the CSS strings from the viewer
  parts — once the parts become thin `/s/:id` iframes, delete the viewer copies
  (MarkdownPart/CodePart/DiffPart/TerminalPart render logic, `highlight.ts`) so
  there's one source of truth.

## File/wiring reference (avoid re-reading)

- **Build:** `vite.config.ts` uses `viteSingleFile` → 12.7 MB inlined `viewer/dist/index.html`.
  Embed build (`viewer/vite.embed.config.ts`, `build:embed`) does NOT inline → already chunked.
- **Serving the viewer:**
  - Node: `server/index.ts:14-22` `readFile(viewer/dist/index.html)` at boot → `viewerHtml`.
  - Workers: `workers/index.ts:7` `import viewerHtml from "../viewer/dist/index.html"` (wrangler.jsonc
    Text rule: `globs: ["**/*.html","**/*.md"]`). One DO (`SideshowBoard`) runs everything; no static-asset routes.
- **`server/app.ts`:** `createApp({store, viewerHtml, ...})` ~241. `/s/:id` handler ~867
  (html-only, 404s other kinds; sets `sandbox allow-scripts` header ~898; reads `?ver=&theme=&mode=`).
  `isPublicReadAllowed` ~189. Auth middleware ~499-535 (`authToken`/`publicRead`/cookie). `MAX_BODY_BYTES=16MiB` ~34.
- **`server/surfacePage.ts`:** `renderHtmlPage` (html parts, CDN-allowlist CSP, kits), `renderSandboxedPart`
  (rich parts, tighter CSP), `buildRichCsp`, `buildCsp` (html, has CDN_ALLOWLIST), `BRIDGE_JS`, `escapeHtml`.
- **`server/kits.ts`:** opt-in CSS/JS bundles injected into html-part docs — the mechanism to inject a mermaid loader.
- **Viewer parts:** `viewer/src/{MarkdownPart,DiffPart,MermaidPart,TerminalPart,CodePart,SandboxedPart}.tsx`.
  CSS strings: `MD_CSS`, `DIFF_CSS`, `MERMAID_CSS`, `TERM_CSS`, `CMT_CSS` (in Card.tsx). Move server-side.
  - markdown-it: `html:false, linkify:true`. mermaid: `securityLevel:'strict'`, dynamic import.
    shiki: `loadLangs` async. diff: @pierre/diffs SSR API.
- **`viewer/src/Card.tsx`:** html parts embed `<iframe sandbox="allow-scripts" src={appPath('/s/:id?part=i&ver=&theme=&mode=')}>`
  (~245-252). Rich parts should do the same once `/s/:id` handles them.
- **`viewer/src/api.ts`:** `appPath(path)`, `appBasePath()`, `api(path,init)` (base-path-aware fetch).
  `host()`/`appPath` keep embed (shadow-root) parity — never hardcode origin.
- `newId()` in `server/types.ts:309`.

## Invariants to preserve (whatever approach)

- Agent/user content that becomes HTML must render at an **opaque origin** (sandbox,
  no `allow-same-origin`). For top-level-load safety it must be a `sandbox` CSP
  **response header**, not just the iframe attribute (a top-level open bypasses the attribute).
- `'unsafe-inline'` only ever covers the trusted bridge; never add a board-origin
  script/connect source to a rich frame's CSP.
- Server runtime-agnostic files (`server/{app,events,mcpHttp,surfacePage,types}.ts`
  - any new `richRender.ts`) — no `node:` imports; must pass `tsconfig.workers.json`.
- Embeddable viewer: go through `host()`/`appPath()`, never `location`/`document`/`:root` directly.

## Validation commands

- `npm test` · `npm run typecheck` (node+workers+viewer) · `npm run lint` · `npm run format:check`
- `npx playwright test <spec> --project=chromium` (WebKit needs libs absent on this host; rely on CI)
- Local test server: `PORT=8231 node server/index.ts` — running with the `/f/:id` build.
  Test card: session `tR9sPCGgXDM`, surface `AQ6BW1jSXrQ`. User views on Chrome 149 at `http://hornet:8231`.

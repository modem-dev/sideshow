import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import {
  BRIDGE_JS,
  escapeHtml,
  renderHtmlPage,
  renderSandboxedPart,
} from "../server/surfacePage.ts";
import { themeById } from "../server/themes.ts";

const ORIGIN = "http://localhost:4000";

// Pull the CSP value out of the rendered <meta> tag.
function csp(html: string): string {
  const m = html.match(/Content-Security-Policy" content="([^"]*)"/);
  assert.ok(m, "rendered page must carry a CSP meta tag");
  return m![1];
}

// Parse the rendered <meta http-equiv> CSP into directive -> source tokens.
// Asserting on exact source tokens (array membership) rather than substring-
// matching the policy string keeps these checks precise and avoids the
// URL-substring-sanitization shape static analysis (correctly) distrusts.
function cspDirectives(doc: string): Record<string, string[]> {
  const m = /content="([^"]*)"/.exec(doc.slice(doc.indexOf("Content-Security-Policy")));
  const policy = m ? m[1] : "";
  const out: Record<string, string[]> = {};
  for (const directive of policy.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

// The CDN allowlist html parts may load from. This is a deliberate, fixed set —
// the test pins it so widening it (a new origin, a wildcard) is a conscious edit
// that updates this list, never an accident.
const ALLOWED_CDNS = [
  "https://cdnjs.cloudflare.com",
  "https://esm.sh",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

test("the CSP locks down default-src and allowlists exactly the known CDNs", () => {
  const policy = csp(renderHtmlPage({ title: "t", html: "<p>x</p>", origin: ORIGIN }));

  // nothing loads unless a later directive re-permits it
  assert.ok(policy.includes("default-src 'none'"), "default-src must be 'none'");

  // script/style are inline + the allowlist, and every CDN appears
  for (const cdn of ALLOWED_CDNS) {
    assert.ok(policy.includes(cdn), `CSP should allow ${cdn}`);
  }

  // the sandbox runs at an opaque origin, so the server origin is what lets
  // uploaded assets embed — it must be present in img/media, and only there
  assert.ok(/img-src[^;]*\bhttp:\/\/localhost:4000\b/.test(policy), "origin missing from img-src");
  assert.ok(
    /media-src[^;]*\bhttp:\/\/localhost:4000\b/.test(policy),
    "origin missing from media-src",
  );
});

test("the CSP never permits same-origin escapes, eval, or a wildcard host", () => {
  const policy = csp(renderHtmlPage({ title: "t", html: "<p>x</p>", origin: ORIGIN }));

  assert.ok(!policy.includes("'self'"), "'self' would defeat the opaque-origin sandbox");
  assert.ok(!policy.includes("'unsafe-eval'"), "eval must stay disallowed");
  // a bare * host source would make the allowlist meaningless
  assert.ok(!/(^|[\s;])\*([\s;]|$)/.test(policy), "no wildcard host source");
  // connect-src is limited to the named CDNs — no bare `https:` scheme source
  // that would open fetch/XHR to any host (the `https://…` CDN URLs are fine)
  const connect = policy.match(/connect-src([^;]*)/)?.[1] ?? "";
  assert.ok(!/https:(?!\/)/.test(connect), "connect-src must not open all of https:");
});

test("the document title is HTML-escaped so a crafted title can't break out", () => {
  const page = renderHtmlPage({
    title: `</title><script>alert(1)</script>`,
    html: "<p>body</p>",
    origin: ORIGIN,
  });
  // the literal closing tag + script must be entity-escaped, not live markup
  assert.ok(page.includes("&lt;/title&gt;&lt;script&gt;"), "title must be escaped");
  assert.ok(!page.includes("<title></title><script>alert(1)"), "title must not break out");
});

test("the part html is embedded verbatim — the sandbox, not escaping, is the guard", () => {
  const body = `<div class="card"><button onclick="x()">go</button></div>`;
  const page = renderHtmlPage({ title: "t", html: body, origin: ORIGIN });
  assert.ok(page.includes(body), "trusted part markup must pass through unaltered");
});

test("the host bridge globals and resize reporter are present in every page", () => {
  const page = renderHtmlPage({ title: "t", html: "<p>x</p>", origin: ORIGIN });
  // a break here silently kills the publish->comment loop, so pin the contract
  assert.ok(page.includes("window.sendPrompt"), "sendPrompt bridge missing");
  assert.ok(page.includes("window.openLink"), "openLink bridge missing");
  assert.ok(page.includes("type: 'resize'"), "resize reporter missing");
});

test("theme tokens are injected and resolve unknown/absent themes to the default", () => {
  // an explicit known theme injects its tokens
  const gruvbox = renderHtmlPage({
    title: "t",
    html: "<p>x</p>",
    origin: ORIGIN,
    theme: "gruvbox",
  });
  assert.ok(gruvbox.includes("--color-background-primary:"), "token CSS missing");

  // an unknown id or no theme both fall back to the default's tokens, never crash
  const unknown = renderHtmlPage({ title: "t", html: "<p>x</p>", origin: ORIGIN, theme: "bogus" });
  const none = renderHtmlPage({ title: "t", html: "<p>x</p>", origin: ORIGIN });
  assert.ok(unknown.includes("--color-text-primary:"));
  assert.equal(
    none.match(/--color-text-primary:[^;]*/)?.[0],
    unknown.match(/--color-text-primary:[^;]*/)?.[0],
    "unknown theme should render identically to the default",
  );
});

test("a pinned mode forces the scheme into html parts but not transparent rich frames", () => {
  const gh = renderHtmlPage({ title: "t", html: "<p>x</p>", origin: ORIGIN, mode: "dark" });
  // the document's used color-scheme is forced so the UA canvas/scrollbars/
  // controls follow it, overriding the static `color-scheme: light dark` default
  assert.ok(/:root\{color-scheme:dark\}/.test(gh), "color-scheme must be pinned to dark");
  // and EVERYTHING that flips by scheme is pinned: the theme tokens AND the kit's
  // own teal/coral SVG accents — so no `@media (prefers-color-scheme)` survives to
  // second-guess the scheme inside the frame
  assert.ok(
    !gh.includes("@media (prefers-color-scheme: dark)"),
    "pinned mode drops the media query",
  );
  assert.ok(gh.includes("--c-teal-bg: rgba(31, 169, 150, 0.18)"), "kit teal accent pinned to dark");

  // light pins the other way; absent mode keeps the OS-driven media query
  const light = renderHtmlPage({ title: "t", html: "<p>x</p>", origin: ORIGIN, mode: "light" });
  assert.ok(/:root\{color-scheme:light\}/.test(light), "color-scheme must be pinned to light");
  const auto = renderHtmlPage({ title: "t", html: "<p>x</p>", origin: ORIGIN });
  assert.ok(!auto.includes("color-scheme:dark"), "no mode → no forced scheme");
  assert.ok(auto.includes("@media (prefers-color-scheme: dark)"), "no mode → OS media query kept");

  // rich/comment frames pin the same way — EXCEPT color-scheme. Those frames are
  // transparent so the themed card surface shows through; a forced color-scheme
  // would paint an opaque UA canvas behind them. So the tokens are pinned (flat
  // :root, dark --text, no media query) but color-scheme is left unset.
  const rich = renderSandboxedPart({ body: "x", css: "", origin: ORIGIN, mode: "dark" });
  const dark = themeById("github").dark;
  assert.ok(
    !rich.includes("color-scheme:"),
    "rich frame must NOT force color-scheme (stays transparent)",
  );
  assert.ok(
    !rich.includes("@media (prefers-color-scheme: dark)"),
    "rich tokens are pinned, no media query",
  );
  assert.ok(
    rich.includes(`--text: ${dark.text}`),
    "rich frame carries the pinned dark chrome vars",
  );
});

test("renderSandboxedPart embeds the body and css inside the sandbox doc", () => {
  const doc = renderSandboxedPart({
    body: "<p>hello</p>",
    css: "p{color:red}",
    origin: ORIGIN,
  });
  assert.ok(doc.includes("<p>hello</p>"), "body is present");
  assert.ok(doc.includes("p{color:red}"), "css is present");
  // srcdoc's base URL is about:srcdoc, so relative URLs (e.g. a markdown image
  // at /a/:id) need an explicit base pinned to the origin to resolve.
  assert.ok(doc.includes(`<base href="${ORIGIN}/">`), "base href pins the origin");
  // the resize/openLink bridge ships in the frame so it can self-size
  assert.ok(doc.includes("postMessage"), "bridge is present");
  // chrome theme vars are injected (viewerThemeCss) so the part matches the viewer
  assert.ok(doc.includes("--bg:"), "theme vars are injected");
});

test("renderSandboxedPart uses a tighter CSP than html parts: no connect-src, no CDN", () => {
  const d = cspDirectives(renderSandboxedPart({ body: "x", css: "", origin: ORIGIN }));
  assert.deepEqual(d["default-src"], ["'none'"], "locked-down default");
  // script-src is EXACTLY the inline bridge — no CDN sources leak in
  assert.deepEqual(d["script-src"], ["'unsafe-inline'"], "only the inline bridge runs");
  // a contained script must have no way to phone home
  assert.ok(!("connect-src" in d), "no connect-src");
  // uploaded images still embed by absolute origin URL
  assert.ok(d["img-src"]?.includes(ORIGIN), "origin allowed for images");
});

test("html parts keep their CDN allowlist (rich-part tightening did not leak)", () => {
  const html = cspDirectives(renderHtmlPage({ title: "t", html: "<b>x</b>", origin: ORIGIN }));
  const rich = cspDirectives(renderSandboxedPart({ body: "x", css: "", origin: ORIGIN }));
  // rich parts lock script-src to the inline bridge alone; html parts add the
  // CDN sources on top, so html's source list is strictly larger. (Asserting on
  // the count rather than a host literal keeps this off the URL-substring path.)
  assert.deepEqual(rich["script-src"], ["'unsafe-inline'"], "rich = inline bridge only");
  assert.ok(
    html["script-src"].length > rich["script-src"].length,
    "html parts keep extra (CDN) script sources",
  );
  assert.ok("connect-src" in html, "html parts still have connect-src");
});

test("the board origin is never a connect/script source — img/media only", () => {
  // The server origin is deliberately in img-src/media-src so uploaded assets
  // embed by URL. It must NEVER reach connect-src or script-src: that origin
  // serves the authenticated board API and the comment->agent channel, so a
  // contained script that could fetch it would defeat the whole sandbox. This
  // is the exact exfil hole the existing 'self'/wildcard/`https:` checks miss —
  // localhost:4000 is none of those, so it would slip past them.
  for (const make of [
    () => renderHtmlPage({ title: "t", html: "<p>x</p>", origin: ORIGIN }),
    () => renderSandboxedPart({ body: "x", css: "", origin: ORIGIN }),
  ]) {
    const d = cspDirectives(make());
    assert.ok(
      !(d["connect-src"] ?? []).includes(ORIGIN),
      "board origin must not be a connect source",
    );
    assert.ok(
      !(d["script-src"] ?? []).includes(ORIGIN),
      "board origin must not be a script source",
    );
    // it is present where it's meant to be, so this test can't pass vacuously
    assert.ok(d["img-src"]?.includes(ORIGIN), "board origin should still embed images");
  }
});

test("escapeHtml neutralizes markup metacharacters", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert(1)">`),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
  );
  assert.equal(escapeHtml("a & b"), "a &amp; b");
});

// Pull the real resize bridge out of a rendered sandboxed part and run it in a
// vm with a fake DOM, so we exercise the SHIPPED code (not a copy). The driver
// feeds the height the content "reports" at a given clock time and captures what
// the bridge posts to the parent.
function loadResizeBridge() {
  // BRIDGE_JS is exactly what ships inside <script>…</script> in every surface
  // page; run it verbatim. (That it's embedded in the page is covered separately
  // by the "host bridge globals and resize reporter are present" test.)
  const src = BRIDGE_JS;

  const posted: number[] = [];
  const clock = { scrollHeight: 0, now: 0 };
  const noop = () => 0;
  const ctx: Record<string, unknown> = {
    parent: {
      postMessage: (msg: { type?: string; height?: number }) => {
        if (msg && msg.type === "resize") posted.push(msg.height!);
      },
    },
    performance: { now: () => clock.now },
    setTimeout: noop, // ignore the deferred __report() warm-up calls
    requestAnimationFrame: noop,
    document: {
      readyState: "loading", // take the load-listener branch, not an eval-time __report()
      body: {
        get scrollHeight() {
          return clock.scrollHeight;
        },
      },
      documentElement: {},
      addEventListener: noop,
    },
    window: { addEventListener: noop }, // no ResizeObserver -> RO wiring is skipped
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const report = ctx.__report as () => void;
  return {
    posted,
    at(height: number, ms: number) {
      clock.scrollHeight = height;
      clock.now = ms;
      report();
    },
  };
}

// Regression: a surface whose height inverts with the frame height (a scrollbar
// that toggles at a threshold, a 100vh/% layout) makes the parent's "size the
// iframe to the reported height" feed back into the content's height, so reports
// alternate A, B, A, B... forever. A plain `h !== lastH` guard can't stop it
// (each value differs from the one before), and on a heavy surface the per-frame
// relayout pegs a CPU core. The bridge must break the rapid 2-cycle while still
// honoring a genuine change that happens to return to a prior height.
test("resize bridge breaks a rapid 2-cycle but honors slow genuine changes", () => {
  const b = loadResizeBridge();

  b.at(100, 0); // first measurement
  b.at(200, 16); // genuine growth
  assert.deepEqual(b.posted, [100, 200]);

  // The runaway: rapid flips back and forth, one per frame.
  b.at(100, 32);
  b.at(200, 48);
  b.at(100, 64);
  assert.deepEqual(
    b.posted,
    [100, 200],
    "a rapid A<->B oscillation must stop after the first cycle",
  );

  // A real change that lands on a previous height, seconds later, still resizes.
  b.at(100, 5000);
  assert.deepEqual(
    b.posted,
    [100, 200, 100],
    "a slow, genuine return to a prior height must still resize the frame",
  );
});

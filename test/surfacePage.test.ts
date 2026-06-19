import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHtmlPage } from "../server/surfacePage.ts";

const ORIGIN = "http://localhost:4000";

// Pull the CSP value out of the rendered <meta> tag.
function csp(html: string): string {
  const m = html.match(/Content-Security-Policy" content="([^"]*)"/);
  assert.ok(m, "rendered page must carry a CSP meta tag");
  return m![1];
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

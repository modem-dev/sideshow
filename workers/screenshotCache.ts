// Short-lived edge cache for the versioned social-card screenshot advertised by
// post permalink metadata.
//
// Authorization and pixel-identity validation happen before cache lookup: the
// board DO must approve `/p/:id?part=0&ver=N&theme=T&mode=M`. A forged or
// unavailable version therefore gets a 404 before it can read or populate cache;
// a deleted post and changed auth policy are likewise enforced on every edge
// request. A hit avoids only the expensive Browser Rendering call.

import { themeOptions } from "../server/themes.ts";
import type { PostScreenshotPlan } from "./screenshot.ts";

const EDGE_MAX_AGE_SECONDS = 3600;
const ORIGIN_CACHE_CONTROL = "x-sideshow-origin-cache-control";
const CACHE_STATUS_HEADER = "x-sideshow-screenshot-cache";

// Only the methods used here, so Node tests can provide a Map-backed stand-in.
export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

// `caches.default` is absent under Node tests and unavailable on workers.dev.
// Both cases safely degrade to an ordinary uncached screenshot.
export function defaultEdgeCache(): EdgeCache | null {
  const store = (globalThis as { caches?: { default?: EdgeCache } }).caches;
  return store?.default ?? null;
}

// A token-protected board must never advertise its bearer-gated image as shared
// cacheable downstream. The internal Cache API copy is separate and remains safe
// because servePostScreenshot reauthorizes before every lookup.
export function postScreenshotClientCacheControl(
  noCache: boolean,
  publicRead: string | undefined,
): string {
  if (noCache) return "no-store";
  return `${publicRead === "session" || publicRead === "full" ? "public" : "private"}, max-age=300`;
}

// Cache only the exact fixed-size, fully pinned shape emitted by postPreviewHead.
// Unrelated tracking parameters are ignored rather than fragmenting the cache.
export function postScreenshotCacheKey(
  method: string,
  requestUrl: URL,
  postId: string,
  plan: PostScreenshotPlan,
  rendererGeneration: string,
): Request | null {
  if (method !== "GET" || plan.noCache || requestUrl.searchParams.get("card") !== "1") {
    return null;
  }

  const version = requestUrl.searchParams.get("v");
  if (!version || !/^(0|[1-9]\d*)$/.test(version)) return null;
  const numericVersion = Number(version);
  if (!Number.isSafeInteger(numericVersion) || numericVersion < 0) return null;

  const theme = requestUrl.searchParams.get("theme");
  if (!theme || !themeOptions().some((option) => option.id === theme)) return null;
  const mode = requestUrl.searchParams.get("mode");
  if (mode !== "light" && mode !== "dark") return null;
  const generation = requestUrl.searchParams.get("g");
  if (!generation || generation !== rendererGeneration) return null;

  // planPostScreenshot maps public markers to renderer query names. Equality
  // ties the cache key to what the DO just validated and Browser Rendering will
  // actually capture.
  if (
    plan.checkUrl.searchParams.get("ver") !== version ||
    plan.checkUrl.searchParams.get("theme") !== theme ||
    plan.checkUrl.searchParams.get("mode") !== mode
  ) {
    return null;
  }

  const params = new URLSearchParams({
    part: plan.checkUrl.searchParams.get("part") ?? "0",
    v: version,
    theme,
    mode,
    g: generation,
  });

  return new Request(
    `${requestUrl.origin}/__cache/post-screenshot/${encodeURIComponent(postId)}.png?${params}`,
    { method: "GET" },
  );
}

function isSafeClientControl(control: string): boolean {
  const normalized = control.toLowerCase();
  if (/\b(?:no-cache|no-store)\b/.test(normalized)) return false;
  const isPublic = /\bpublic\b/.test(normalized);
  const isPrivate = /\bprivate\b/.test(normalized);
  // Exactly one audience directive must be present. The internal Cache API copy
  // is public either way; this original policy is restored only to the client.
  return isPublic !== isPrivate;
}

function isPng(res: Response): boolean {
  return res.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "image/png";
}

function isStorable(res: Response): boolean {
  return (
    res.status === 200 &&
    isPng(res) &&
    !res.headers.has("set-cookie") &&
    isSafeClientControl(res.headers.get("cache-control") ?? "")
  );
}

function storableCopy(res: Response): Response {
  const copy = res.clone();
  const stored = new Response(copy.body, copy);
  stored.headers.set(ORIGIN_CACHE_CONTROL, res.headers.get("cache-control") ?? "no-store");
  stored.headers.set("cache-control", `public, max-age=${EDGE_MAX_AGE_SECONDS}`);
  return stored;
}

function isUsableHit(res: Response): boolean {
  return (
    res.status === 200 &&
    isPng(res) &&
    isSafeClientControl(res.headers.get(ORIGIN_CACHE_CONTROL) ?? "")
  );
}

function tagged(res: Response, state: "hit" | "miss"): Response {
  const out = new Response(res.body, res);
  const originControl =
    out.headers.get(ORIGIN_CACHE_CONTROL) ??
    (state === "miss" ? (out.headers.get("cache-control") ?? "") : "");
  out.headers.set("cache-control", isSafeClientControl(originControl) ? originControl : "no-store");
  out.headers.delete(ORIGIN_CACHE_CONTROL);
  out.headers.set(CACHE_STATUS_HEADER, state);
  return out;
}

export async function withPostScreenshotCache(
  key: Request | null,
  defer: (promise: Promise<unknown>) => void,
  capture: () => Promise<Response>,
  cache: EdgeCache | null = defaultEdgeCache(),
): Promise<Response> {
  if (!key || !cache) return capture();

  const hit = await cache.match(key).catch(() => undefined);
  if (hit && isUsableHit(hit)) return tagged(hit, "hit");

  const res = await capture();
  if (!isStorable(res)) return res;
  defer(cache.put(key, storableCopy(res)).catch(() => {}));
  return tagged(res, "miss");
}

export interface ServePostScreenshotOptions {
  request: Request;
  requestUrl: URL;
  postId: string;
  plan: PostScreenshotPlan;
  rendererGeneration: string;
  clientCacheControl: string;
  defer: (promise: Promise<unknown>) => void;
  // Must perform the real board-app read with the caller's credentials. Keeping
  // this callback inside the orchestration function makes auth-before-cache a
  // testable invariant rather than merely call-site ordering.
  authorize: () => Promise<Response>;
  capture: () => Promise<Response>;
  cache?: EdgeCache | null;
}

// Authorize and validate at the DO first, then serve/fill the edge cache. The
// capture callback returns Browser Rendering's response; this function owns the
// final PNG and client cache headers so private deployments cannot accidentally
// emit a public response.
export async function servePostScreenshot({
  request,
  requestUrl,
  postId,
  plan,
  rendererGeneration,
  clientCacheControl,
  defer,
  authorize,
  capture,
  cache = defaultEdgeCache(),
}: ServePostScreenshotOptions): Promise<Response> {
  const checkRes = await authorize();
  if (!checkRes.ok) return checkRes;
  await checkRes.arrayBuffer();

  if (request.method === "HEAD") {
    return new Response(null, {
      headers: { "content-type": "image/png", "cache-control": clientCacheControl },
    });
  }

  const key = postScreenshotCacheKey(request.method, requestUrl, postId, plan, rendererGeneration);
  const response = await withPostScreenshotCache(
    key,
    defer,
    async () => {
      const screenshot = await capture();
      return new Response(await screenshot.arrayBuffer(), {
        headers: { "content-type": "image/png", "cache-control": clientCacheControl },
      });
    },
    cache,
  );
  // Access policy may change while the pixel identity stays the same (for
  // example, public-read is disabled after a card was cached). Authorization
  // above uses the CURRENT policy, so its client directive must also win over
  // the policy recorded with an older internal entry.
  const out = new Response(response.body, response);
  out.headers.set("cache-control", clientCacheControl);
  return out;
}

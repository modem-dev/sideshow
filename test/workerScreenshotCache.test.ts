import assert from "node:assert/strict";
import { test } from "node:test";
import { planPostScreenshot } from "../workers/screenshot.ts";
import {
  postScreenshotCacheKey,
  postScreenshotClientCacheControl,
  type EdgeCache,
  servePostScreenshot,
  withPostScreenshotCache,
} from "../workers/screenshotCache.ts";

const GENERATION = "1.2.3";
const cardUrl = (version = "7", extra = "") =>
  `https://board.test/p/post_1.png?card=1&theme=github&mode=dark&v=${version}&g=${GENERATION}${extra}`;

function plan(href: string) {
  const url = new URL(href);
  return { url, plan: planPostScreenshot(url, "post_1", null) };
}

function memoryCache() {
  const entries = new Map<string, Response>();
  const cache: EdgeCache = {
    async match(request) {
      return entries.get(request.url)?.clone();
    },
    async put(request, response) {
      entries.set(request.url, response.clone());
    },
  };
  return { cache, entries };
}

function png(cacheControl = "public, max-age=300", extraHeaders: Record<string, string> = {}) {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: {
      "content-type": "image/png",
      "cache-control": cacheControl,
      ...extraHeaders,
    },
  });
}

test("protected screenshots stay private downstream; public-read cards remain shareable", () => {
  assert.equal(postScreenshotClientCacheControl(false, undefined), "private, max-age=300");
  assert.equal(postScreenshotClientCacheControl(false, "unexpected"), "private, max-age=300");
  assert.equal(postScreenshotClientCacheControl(false, "session"), "public, max-age=300");
  assert.equal(postScreenshotClientCacheControl(false, "full"), "public, max-age=300");
  assert.equal(postScreenshotClientCacheControl(true, "full"), "no-store");
});

test("social-card key pins version, theme, mode, and renderer generation", () => {
  const { url, plan: screenshot } = plan(cardUrl("7", "&utm_source=preview"));
  const key = postScreenshotCacheKey("GET", url, "post_1", screenshot, GENERATION);
  assert.equal(
    key?.url,
    "https://board.test/__cache/post-screenshot/post_1.png?part=0&v=7&theme=github&mode=dark&g=1.2.3",
  );
  assert.equal(screenshot.checkUrl.searchParams.get("ver"), "7");
  assert.equal(screenshot.checkUrl.searchParams.get("theme"), "github");
  assert.equal(screenshot.checkUrl.searchParams.get("mode"), "dark");
  assert.doesNotMatch(key!.url, /utm/);
});

test("only canonical, fully pinned metadata cards are cacheable", () => {
  for (const [label, href, method, generation] of [
    ["unversioned", cardUrl("").replace("&v=&", "&"), "GET", GENERATION],
    ["non-card", cardUrl().replace("card=1&", ""), "GET", GENERATION],
    ["HEAD", cardUrl(), "HEAD", GENERATION],
    ["nocache", cardUrl("1", "&nocache"), "GET", GENERATION],
    ["missing theme", cardUrl().replace("theme=github&", ""), "GET", GENERATION],
    ["unknown theme", cardUrl().replace("theme=github", "theme=made-up"), "GET", GENERATION],
    ["missing mode", cardUrl().replace("mode=dark&", ""), "GET", GENERATION],
    ["OS mode", cardUrl().replace("mode=dark", "mode=os"), "GET", GENERATION],
    ["missing generation", cardUrl().replace(`&g=${GENERATION}`, ""), "GET", GENERATION],
    ["stale generation", cardUrl(), "GET", "2.0.0"],
    ["leading zero", cardUrl("01"), "GET", GENERATION],
    ["unsafe integer", cardUrl(String(Number.MAX_SAFE_INTEGER + 1)), "GET", GENERATION],
  ] as const) {
    const { url, plan: screenshot } = plan(href);
    assert.equal(
      postScreenshotCacheKey(method, url, "post_1", screenshot, generation),
      null,
      label,
    );
  }

  const { url, plan: screenshot } = plan(cardUrl("2"));
  screenshot.checkUrl.searchParams.set("ver", "1");
  assert.equal(postScreenshotCacheKey("GET", url, "post_1", screenshot, GENERATION), null);
});

test("a miss stores a one-hour internal copy but restores a private client policy", async () => {
  const { url, plan: screenshot } = plan(cardUrl());
  const key = postScreenshotCacheKey("GET", url, "post_1", screenshot, GENERATION)!;
  const { cache, entries } = memoryCache();
  const deferred: Promise<unknown>[] = [];
  let captures = 0;

  const response = await withPostScreenshotCache(
    key,
    (promise) => deferred.push(promise),
    async () => {
      captures++;
      return png("private, max-age=300");
    },
    cache,
  );
  await Promise.all(deferred);

  assert.equal(captures, 1);
  assert.equal(response.headers.get("x-sideshow-screenshot-cache"), "miss");
  assert.equal(response.headers.get("cache-control"), "private, max-age=300");
  const stored = entries.get(key.url)!;
  assert.equal(stored.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(stored.headers.get("x-sideshow-origin-cache-control"), "private, max-age=300");
});

test("a valid hit skips capture and restores its client cache policy", async () => {
  const { url, plan: screenshot } = plan(cardUrl());
  const key = postScreenshotCacheKey("GET", url, "post_1", screenshot, GENERATION)!;
  const { cache } = memoryCache();
  await cache.put(
    key,
    png("public, max-age=3600", {
      "x-sideshow-origin-cache-control": "public, max-age=300",
    }),
  );
  let captures = 0;

  const response = await withPostScreenshotCache(
    key,
    () => {},
    async () => {
      captures++;
      return png();
    },
    cache,
  );

  assert.equal(captures, 0);
  assert.equal(response.headers.get("x-sideshow-screenshot-cache"), "hit");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(response.headers.has("x-sideshow-origin-cache-control"), false);
});

test("malformed hits and unsafe capture responses never escape into shared cache", async () => {
  const { url, plan: screenshot } = plan(cardUrl());
  const key = postScreenshotCacheKey("GET", url, "post_1", screenshot, GENERATION)!;
  const { cache } = memoryCache();
  await cache.put(
    key,
    png("public, max-age=3600", {
      "x-sideshow-origin-cache-control": "public, private, max-age=300",
    }),
  );
  let captures = 0;
  const deferred: Promise<unknown>[] = [];
  const repaired = await withPostScreenshotCache(
    key,
    (promise) => deferred.push(promise),
    async () => {
      captures++;
      return png();
    },
    cache,
  );
  await Promise.all(deferred);
  assert.equal(captures, 1);
  assert.equal(repaired.headers.get("x-sideshow-screenshot-cache"), "miss");

  for (const [label, response] of [
    ["mixed-case no-store", png("public, No-Store")],
    ["contradictory", png("private, public")],
    ["cookie", png(undefined, { "set-cookie": "x=1" })],
    [
      "not PNG",
      new Response("text", {
        headers: { "content-type": "text/plain", "cache-control": "public, max-age=300" },
      }),
    ],
  ] as const) {
    let puts = 0;
    const rejectingCache: EdgeCache = {
      async match() {
        return undefined;
      },
      async put() {
        puts++;
      },
    };
    await withPostScreenshotCache(
      key,
      () => {},
      async () => response,
      rejectingCache,
    );
    assert.equal(puts, 0, label);
  }
});

test("Browser Rendering errors stay errors and never enter the edge cache", async () => {
  const request = new Request(cardUrl());
  const { url, plan: screenshot } = plan(cardUrl());
  const { cache, entries } = memoryCache();
  const deferred: Promise<unknown>[] = [];

  const response = await servePostScreenshot({
    request,
    requestUrl: url,
    postId: "post_1",
    plan: screenshot,
    rendererGeneration: GENERATION,
    clientCacheControl: "private, max-age=300",
    defer: (promise) => deferred.push(promise),
    authorize: async () => new Response("renderable"),
    capture: async () =>
      new Response('{"error":"rate limited"}', {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    cache,
  });
  await Promise.all(deferred);

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), '{"error":"rate limited"}');
  assert.equal(entries.size, 0);
});

test("a non-PNG capture never gains a client cache policy", async () => {
  const request = new Request(cardUrl());
  const { url, plan: screenshot } = plan(cardUrl());
  const { cache, entries } = memoryCache();

  const response = await servePostScreenshot({
    request,
    requestUrl: url,
    postId: "post_1",
    plan: screenshot,
    rendererGeneration: GENERATION,
    clientCacheControl: "public, max-age=300",
    defer: () => {},
    authorize: async () => new Response("renderable"),
    capture: async () =>
      new Response("not an image", { headers: { "content-type": "text/plain" } }),
    cache,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "not an image");
  assert.equal(entries.size, 0);
});

test("orchestration revalidates before hits and applies the current access policy", async () => {
  const request = () => new Request(cardUrl());
  const { url, plan: screenshot } = plan(cardUrl());
  const { cache } = memoryCache();
  const deferred: Promise<unknown>[] = [];
  let authorized = true;
  let clientCacheControl = "public, max-age=300";
  let authorizationChecks = 0;
  let captures = 0;

  const serve = () =>
    servePostScreenshot({
      request: request(),
      requestUrl: url,
      postId: "post_1",
      plan: screenshot,
      rendererGeneration: GENERATION,
      clientCacheControl,
      defer: (promise) => deferred.push(promise),
      authorize: async () => {
        authorizationChecks++;
        return authorized ? new Response("renderable") : new Response("not found", { status: 404 });
      },
      capture: async () => {
        captures++;
        return png();
      },
      cache,
    });

  const miss = await serve();
  await Promise.all(deferred.splice(0));
  // Simulate disabling public-read after the public image was cached. The same
  // pixels may be reused after authorization, but the OLD public directive must not.
  clientCacheControl = "private, max-age=300";
  const hit = await serve();
  assert.equal(miss.headers.get("x-sideshow-screenshot-cache"), "miss");
  assert.equal(miss.headers.get("cache-control"), "public, max-age=300");
  assert.equal(hit.headers.get("x-sideshow-screenshot-cache"), "hit");
  assert.equal(hit.headers.get("cache-control"), "private, max-age=300");
  assert.equal(authorizationChecks, 2);
  assert.equal(captures, 1);

  authorized = false;
  const deletedOrDenied = await serve();
  assert.equal(deletedOrDenied.status, 404);
  assert.equal(authorizationChecks, 3);
  assert.equal(captures, 1);
});

test("HEAD authorizes but never reads cache or invokes Browser Rendering", async () => {
  const request = new Request(cardUrl(), { method: "HEAD" });
  const { url, plan: screenshot } = plan(cardUrl());
  let cacheReads = 0;
  let captures = 0;
  const cache: EdgeCache = {
    async match() {
      cacheReads++;
      return undefined;
    },
    async put() {},
  };
  const response = await servePostScreenshot({
    request,
    requestUrl: url,
    postId: "post_1",
    plan: screenshot,
    rendererGeneration: GENERATION,
    clientCacheControl: "public, max-age=300",
    defer: () => {},
    authorize: async () => new Response("renderable"),
    capture: async () => {
      captures++;
      return png();
    },
    cache,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(cacheReads, 0);
  assert.equal(captures, 0);
});

export interface PostScreenshotPlan {
  checkUrl: URL;
  target: string;
  viewport: { width: number; height: number };
  screenshotOptions: { fullPage: boolean };
  noCache: boolean;
}

/** @deprecated Use PostScreenshotPlan. */
export type SurfaceScreenshotPlan = PostScreenshotPlan;

export function matchPostScreenshot(method: string, pathname: string): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  // Keep this independent of the post id alphabet. The store owns id validity;
  // the Worker only recognizes the stable one-segment screenshot shape and
  // forwards the captured id to the app for the real existence/auth check. That
  // way a future id alphabet change doesn't break link previews.
  return pathname.match(/^\/s\/([^/]+)\.png$/)?.[1] ?? null;
}

export function planPostScreenshot(
  requestUrl: URL,
  postId: string,
  cookieHeader: string | null,
): PostScreenshotPlan {
  const card = requestUrl.searchParams.get("card") === "1";
  const width = card
    ? 1200
    : Math.min(Math.max(Number(requestUrl.searchParams.get("w")) || 800, 320), 1920);
  const theme = requestUrl.searchParams.get("theme");
  const modeParam = requestUrl.searchParams.get("mode");
  const modeCookie = cookieHeader?.match(/sideshow_mode=(light|dark)/)?.[1];
  const mode =
    modeParam === "dark" || modeParam === "light"
      ? modeParam
      : (modeCookie as "light" | "dark" | undefined);

  const checkUrl = new URL(requestUrl);
  checkUrl.pathname = `/s/${postId}`;
  checkUrl.search = ""; // clear .png query params, including tokens
  checkUrl.searchParams.set("part", "0");
  if (theme) checkUrl.searchParams.set("theme", theme);
  if (mode) checkUrl.searchParams.set("mode", mode);

  return {
    checkUrl,
    target: checkUrl.toString(),
    viewport: { width, height: card ? 630 : 800 },
    screenshotOptions: { fullPage: !card },
    noCache: requestUrl.searchParams.has("nocache"),
  };
}

/** @deprecated Use matchPostScreenshot. */
export const matchSurfaceScreenshot = matchPostScreenshot;

/** @deprecated Use planPostScreenshot. */
export const planSurfaceScreenshot = planPostScreenshot;

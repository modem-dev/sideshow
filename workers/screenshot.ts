export interface SurfaceScreenshotPlan {
  checkUrl: URL;
  target: string;
  viewport: { width: number; height: number };
  screenshotOptions: { fullPage: boolean };
  noCache: boolean;
}

export function matchSurfaceScreenshot(method: string, pathname: string): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  return pathname.match(/^\/s\/([a-z0-9]+)\.png$/)?.[1] ?? null;
}

export function planSurfaceScreenshot(
  requestUrl: URL,
  surfaceId: string,
  cookieHeader: string | null,
): SurfaceScreenshotPlan {
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
  checkUrl.pathname = `/s/${surfaceId}`;
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

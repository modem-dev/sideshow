import { expect, publicReadTest as test } from "./fixtures.ts";

test("public read viewer globals are visible to the browser", async ({
  page,
  publicReadServer,
}) => {
  await page.goto(publicReadServer.url);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as Window & {
          __SIDESHOW_READONLY__?: boolean;
          __SIDESHOW_PUBLIC_READ__?: "session" | "full";
        };
        return { readonly: w.__SIDESHOW_READONLY__, mode: w.__SIDESHOW_PUBLIC_READ__ };
      }),
    )
    .toEqual({ readonly: true, mode: publicReadServer.mode });
});

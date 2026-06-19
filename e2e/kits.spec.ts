import { expect, publishParts, test } from "./fixtures.ts";

// html-part iframe (the sandboxed /s/:id doc), as opposed to the comment frame.
const PART_FRAME = 'iframe[src*="/s/"]';

test("the slides kit renders a stepped deck with injected controls", async ({ page, server }) => {
  await publishParts(server.url, {
    title: "Deck",
    agent: "e2e",
    parts: [
      {
        kind: "html",
        kits: ["slides"],
        html:
          '<div class="deck">' +
          '<section class="slide"><h2>First</h2><p>alpha</p></section>' +
          '<section class="slide"><h2>Second</h2><p>bravo</p></section>' +
          "</div>",
      },
    ],
  });

  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)").first();
  const frame = card.frameLocator(PART_FRAME);

  // the kit's js injected a control bar, and the counter reads the deck size
  await expect(frame.locator(".deck-num")).toHaveText("1 / 2");
  // only the first slide is shown
  await expect(frame.locator(".slide.on")).toContainText("First");
  await expect(frame.locator(".slide.on")).not.toContainText("Second");

  // advancing with the injected next button moves to slide 2 (interactive js,
  // not just css — proves a behavior kit, not only styling)
  await frame.locator(".deck-ctl button").last().click();
  await expect(frame.locator(".deck-num")).toHaveText("2 / 2");
  await expect(frame.locator(".slide.on")).toContainText("Second");
});

test("the issues kit styles plain markup as a rail tree", async ({ page, server }) => {
  await publishParts(server.url, {
    title: "Tree",
    agent: "e2e",
    parts: [
      {
        kind: "html",
        kits: ["issues"],
        html:
          '<ul class="tree"><li class="row"><span class="chip">ENG-1</span>' +
          '<span class="grow">Parent</span><span class="badge ok">done</span>' +
          '<ul class="tree"><li class="row"><span class="chip">ENG-2</span>' +
          '<span class="grow">Child</span></li></ul></li></ul>',
      },
    ],
  });

  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)").first();
  const frame = card.frameLocator(PART_FRAME);

  // the badge picks up the kit's tinted-pill background (not transparent)
  const badge = frame.locator(".badge.ok");
  await expect(badge).toBeVisible();
  const bg = await badge.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");

  // the nested .tree indents via a left-border rail — structural, kit-supplied
  const subtree = frame.locator(".tree .tree");
  await expect(subtree).toBeVisible();
  const borderLeft = await subtree.evaluate((el) => getComputedStyle(el).borderLeftWidth);
  expect(parseFloat(borderLeft)).toBeGreaterThan(0);
});

test("a default html part (no kits) gets none of the kit styling", async ({ page, server }) => {
  await publishParts(server.url, {
    title: "Bare",
    agent: "e2e",
    parts: [{ kind: "html", html: '<span class="badge ok">unstyled</span>' }],
  });

  await page.goto(server.url);
  const card = page.locator(".card:not(#whatsNew)").first();
  const frame = card.frameLocator(PART_FRAME);

  // the class exists in the markup but no kit defined it → transparent background
  const badge = frame.locator(".badge.ok");
  await expect(badge).toBeVisible();
  const bg = await badge.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgba(0, 0, 0, 0)");
});

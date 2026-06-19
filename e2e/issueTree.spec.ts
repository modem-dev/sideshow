import { expect, publishParts, test } from "./fixtures.ts";

const ROOT = {
  ref: "ENG-204",
  title: "Normalize issue states across providers",
  state: "in-progress",
  source: "linear",
  children: [
    { ref: "octo/web #1432", title: "Dark mode regression", state: "done", source: "github" },
    { ref: "ENG-219", title: "Map GitHub closed states", state: "done", source: "linear" },
    {
      ref: "SUP-881",
      title: "SSO login fails for SAML customers",
      state: "blocked",
      source: "jira",
      children: [
        { ref: "JS-4F2", title: "TypeError reading 'theme'", state: "open", source: "sentry" },
      ],
    },
    { ref: "infra/ci !57", title: "Bump CI runners", state: "in-progress", source: "gitlab" },
  ],
};

test("an issue-tree part renders a native rail tree with a computed rollup", async ({
  page,
  server,
}) => {
  await publishParts(server.url, {
    title: "Sub-issues",
    agent: "e2e",
    parts: [{ kind: "issue-tree", root: ROOT }],
  });

  await page.goto(server.url);
  const card = page.locator(".card:not(#sessionThread)");
  const tree = card.locator(".itree");

  // rendered natively in the viewer document (no sandboxed iframe)
  await expect(tree).toBeVisible();
  await expect(card.locator("iframe")).toHaveCount(0);

  // the epic header and a nested cross-provider leaf both made it in
  await expect(tree.locator(".itree-epic-title")).toContainText("Normalize issue states");
  await expect(tree).toContainText("ENG-204");
  await expect(tree).toContainText("JS-4F2");

  // rollup is computed from descendants (2 done of 5: #1432, ENG-219)
  await expect(tree.locator(".itree-prog")).toContainText("2 / 5 done");
  await expect(tree.locator(".itree-prog")).toContainText("40%");

  // structural depth: the grandchild lives two subtrees deep, so a regression
  // that flattened the tree into siblings would fail this (a visibility-only
  // check would not).
  await expect(
    tree.locator(".itree-subtree .itree-subtree .itree-node", { hasText: "JS-4F2" }),
  ).toBeVisible();
});

test("a javascript: url on a node is not rendered as an executable link", async ({
  page,
  server,
}) => {
  await publishParts(server.url, {
    title: "Links",
    agent: "e2e",
    parts: [
      {
        kind: "issue-tree",
        root: {
          ref: "SAFE-1",
          title: "Epic",
          state: "open",
          url: "https://example.com/epic",
          children: [
            {
              ref: "EVIL-1",
              title: "xss",
              state: "open",
              url: "javascript:alert(document.domain)",
            },
          ],
        },
      },
    ],
  });

  await page.goto(server.url);
  const tree = page.locator(".card:not(#sessionThread) .itree");
  // the safe https ref is a real anchor
  await expect(tree.locator('a.itree-ref[href="https://example.com/epic"]')).toBeVisible();
  // the javascript: ref is dropped to plain text — no anchor carries it
  await expect(tree.locator("a.itree-ref", { hasText: "EVIL-1" })).toHaveCount(0);
  await expect(tree.locator("span.itree-ref", { hasText: "EVIL-1" })).toBeVisible();
  // and no anchor anywhere has a javascript: href
  await expect(tree.locator('a[href^="javascript:"]')).toHaveCount(0);
});

test("an issue-tree with no children renders the epic and an empty note", async ({
  page,
  server,
}) => {
  await publishParts(server.url, {
    title: "Lonely",
    agent: "e2e",
    parts: [{ kind: "issue-tree", root: { ref: "ENG-1", title: "Just me", state: "open" } }],
  });

  await page.goto(server.url);
  const tree = page.locator(".card:not(#sessionThread) .itree");
  await expect(tree.locator(".itree-epic-title")).toContainText("Just me");
  // no descendants → no rollup bar, and the empty-state note shows
  await expect(tree.locator(".itree-prog")).toHaveCount(0);
  await expect(tree.locator(".itree-empty")).toBeVisible();
});

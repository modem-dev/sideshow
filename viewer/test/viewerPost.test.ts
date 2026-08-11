import { expect, test } from "vitest";
import type { ViewerPost } from "../../server/apiViews.ts";
import type { Post } from "../../server/types.ts";
import { compactViewerPost } from "../src/viewerPost.ts";

const compact: ViewerPost = {
  id: "post-1",
  sessionId: "session-1",
  title: "Current",
  surfaces: [{ id: "surface-1", kind: "html", index: 0 }],
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:01:00.000Z",
  version: 2,
  versionCount: 2,
};

test("compactViewerPost accepts the explicit viewer representation", () => {
  expect(compactViewerPost(compact)).toBe(compact);
});

test("compactViewerPost reduces older detail responses to current render data", () => {
  const detail: Post = {
    id: "post-1",
    sessionId: "session-1",
    title: "Current",
    surfaces: [
      { id: "surface-1", kind: "html", html: "<p>current</p>" },
      { id: "surface-2", kind: "json", data: { current: true } },
    ],
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:01:00.000Z",
    version: 2,
    history: [
      {
        version: 1,
        title: "Earlier",
        surfaces: [{ id: "surface-1", kind: "html", html: "<p>earlier</p>" }],
        at: "2026-08-11T00:00:00.000Z",
      },
    ],
  };

  expect(compactViewerPost(detail)).toEqual({
    id: detail.id,
    sessionId: detail.sessionId,
    title: detail.title,
    surfaces: [
      { id: "surface-1", kind: "html", html: "<p>current</p>", index: 0 },
      { id: "surface-2", kind: "json", data: { current: true }, index: 1 },
    ],
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    version: detail.version,
    versionCount: 2,
  });
});

test("compactViewerPost rejects malformed rows instead of hydrating partial state", () => {
  for (const value of [
    null,
    "post-1",
    {},
    { ...compact, id: 1 },
    { ...compact, sessionId: null },
    { ...compact, versionCount: "2" },
    { ...compact, surfaces: null },
    { history: [], surfaces: null },
  ]) {
    expect(compactViewerPost(value)).toBeNull();
  }
});

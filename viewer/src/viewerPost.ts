import type { ViewerPost } from "../../server/apiViews.ts";
import type { Post } from "../../server/types.ts";

function isViewerPost(value: unknown): value is ViewerPost {
  if (!value || typeof value !== "object") return false;
  const post = value as Partial<ViewerPost>;
  return (
    typeof post.id === "string" &&
    typeof post.sessionId === "string" &&
    typeof post.versionCount === "number" &&
    Array.isArray(post.surfaces)
  );
}

// Compatibility bridge for an older server's `?hydrate=1` response (or a full
// detail fallback): reduce its history to the retained count immediately so the
// viewer state always has the compact ViewerPost contract.
export function viewerPostFromDetail(post: Post): ViewerPost {
  const { history, ...current } = post;
  return {
    ...current,
    surfaces: current.surfaces.map((surface, index) => ({ ...surface, index })),
    versionCount: history.length + 1,
  };
}

export function compactViewerPost(value: unknown): ViewerPost | null {
  if (isViewerPost(value)) return value;
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as Partial<Post>).history) &&
    Array.isArray((value as Partial<Post>).surfaces)
  ) {
    return viewerPostFromDetail(value as Post);
  }
  return null;
}

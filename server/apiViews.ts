import { isSandboxedSurfaceKind, SURFACE_CONTENT_FIELDS } from "./types.ts";
import type { Comment, CommentAnchor, Post, Session, Surface } from "./types.ts";

export interface Feedback {
  postId: string | null;
  postTitle: string | null;
  surfaceId: string | null;
  surfaceTitle: string | null;
  text: string;
  at: string;
  anchor?: CommentAnchor;
}

export const surfaceRef = (surface: Pick<Surface, "id" | "kind">, index: number) => ({
  id: surface.id,
  kind: surface.kind,
  index,
});

export const fullSurfaceView = (surface: Surface, index: number) => ({ ...surface, index });

// Session REST lists keep non-html structured payloads for the viewer list, but
// omit arbitrary html bodies. Legacy `parts` aliases the same array at the row.
export const sessionListSurfaceView = (surface: Surface, index: number) =>
  surface.kind === "html" ? surfaceRef(surface, index) : fullSurfaceView(surface, index);

// A sandboxed surface renders as an opaque-origin iframe pointed at
// /s/:id?part=N, which fetches the body itself — so the viewer builds the frame
// from the ref alone and never reads the content field. Shipping the body in the
// session hydrate too made every stream load carry a second, unread copy of every
// surface, the larger half of the response. Drop just that field; the rest of the
// surface (id, kits, …) is small and stays. Native kinds (image/trace/json) DO
// render from inline data, so they keep everything.
export const hydratedSurfaceView = (surface: Surface, index: number) => {
  const field = isSandboxedSurfaceKind(surface.kind)
    ? SURFACE_CONTENT_FIELDS[surface.kind]
    : undefined;
  if (!field) return fullSurfaceView(surface, index);
  // Surface is a union of interfaces, so the content key can't be dropped through
  // the union type (no implicit index signature). Widen to a bag, delete the one
  // key, and let the result type stay the bag — the shape is kind-dependent and
  // this value only ever gets serialized.
  const view = { ...surface, index } as unknown as Record<string, unknown>;
  delete view[field];
  return view;
};

export const postWriteView = (post: Post) => ({
  id: post.id,
  sessionId: post.sessionId,
  title: post.title,
  createdAt: post.createdAt,
  updatedAt: post.updatedAt,
  version: post.version,
  surfaces: post.surfaces.map(surfaceRef),
});

export const postDetailView = (post: Post) => ({
  ...post,
  surfaces: post.surfaces.map(fullSurfaceView),
  history: post.history.map((version) => ({
    ...version,
    surfaces: version.surfaces.map(fullSurfaceView),
  })),
});

// The current surface metadata/data the viewer renders. Sandboxed kinds omit
// their body (the iframe fetches it from /s/:id); native kinds keep their inline
// data. Extra kind-specific fields are intentionally open-ended so a newer
// server can send metadata an older viewer safely ignores.
export interface ViewerSurface {
  id?: string;
  kind: Surface["kind"];
  index: number;
  [key: string]: unknown;
}

// Compact post representation used only by the live viewer. versionCount is the
// number of retained/renderable versions INCLUDING current; it can be lower than
// `version` after HISTORY_LIMIT rolls old revisions out of the store.
export interface ViewerPost {
  id: string;
  sessionId: string;
  title: string;
  surfaces: ViewerSurface[];
  createdAt: string;
  updatedAt: string;
  version: number;
  versionCount: number;
}

export const viewerPostView = (post: Post): ViewerPost => ({
  id: post.id,
  sessionId: post.sessionId,
  title: post.title,
  surfaces: post.surfaces.map(hydratedSurfaceView) as ViewerSurface[],
  createdAt: post.createdAt,
  updatedAt: post.updatedAt,
  version: post.version,
  versionCount: post.history.length + 1,
});

// One session's whole stream, hydrated in a single response (`?hydrate=1`). It
// uses the same compact wire contract as the per-post live-update route.
export const sessionPostHydratedView = viewerPostView;

export const sessionPostListRowView = (post: Post) => {
  const surfaces = post.surfaces.map(sessionListSurfaceView);
  return {
    id: post.id,
    sessionId: post.sessionId,
    title: post.title,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    version: post.version,
    surfaces,
    parts: surfaces,
  };
};

export const mcpPostListRowView = (
  post: Pick<Post, "id" | "sessionId" | "title" | "version" | "updatedAt"> & {
    surfaces: Pick<Surface, "id" | "kind">[];
  },
) => ({
  id: post.id,
  sessionId: post.sessionId,
  title: post.title,
  version: post.version,
  updatedAt: post.updatedAt,
  surfaces: post.surfaces.map(surfaceRef),
});

const PART_TEXT_CAP = 8_000;
const TRACE_STEP_PREVIEW_LIMIT = 25;
type CappedSurface = Surface & { truncated?: true };

function capText(text: string): { value: string; truncated: boolean } {
  return text.length > PART_TEXT_CAP
    ? { value: text.slice(0, PART_TEXT_CAP), truncated: true }
    : { value: text, truncated: false };
}

function capSurface(surface: Surface): CappedSurface {
  switch (surface.kind) {
    case "html": {
      const { value, truncated } = capText(surface.html);
      return truncated ? { ...surface, html: value, truncated: true } : surface;
    }
    case "markdown": {
      const { value, truncated } = capText(surface.markdown);
      return truncated ? { ...surface, markdown: value, truncated: true } : surface;
    }
    case "mermaid": {
      const { value, truncated } = capText(surface.mermaid);
      return truncated ? { ...surface, mermaid: value, truncated: true } : surface;
    }
    case "code": {
      const { value, truncated } = capText(surface.code);
      return truncated ? { ...surface, code: value, truncated: true } : surface;
    }
    case "terminal": {
      const { value, truncated } = capText(surface.text);
      return truncated ? { ...surface, text: value, truncated: true } : surface;
    }
    case "diff": {
      let truncated = false;
      const next: CappedSurface = { ...surface };
      if (surface.patch !== undefined) {
        const capped = capText(surface.patch);
        next.patch = capped.value;
        truncated ||= capped.truncated;
      }
      if (surface.files !== undefined) {
        next.files = surface.files.map((file) => {
          const before = capText(file.before);
          const after = capText(file.after);
          const filename = capText(file.filename);
          const language = file.language ? capText(file.language) : undefined;
          truncated ||= before.truncated || after.truncated || filename.truncated;
          if (language) truncated ||= language.truncated;
          return {
            ...file,
            filename: filename.value,
            before: before.value,
            after: after.value,
            ...(language && { language: language.value }),
          };
        });
      }
      return truncated ? { ...next, truncated: true } : surface;
    }
    case "image": {
      const alt = surface.alt ? capText(surface.alt) : undefined;
      const caption = surface.caption ? capText(surface.caption) : undefined;
      const truncated = !!alt?.truncated || !!caption?.truncated;
      return truncated
        ? {
            ...surface,
            ...(alt && { alt: alt.value }),
            ...(caption && { caption: caption.value }),
            truncated: true,
          }
        : surface;
    }
    case "trace": {
      let truncated = false;
      const title = surface.title ? capText(surface.title) : undefined;
      if (title?.truncated) truncated = true;
      const steps = surface.steps?.slice(0, TRACE_STEP_PREVIEW_LIMIT).map((step) => {
        const label = capText(step.label);
        const kind = step.kind ? capText(step.kind) : undefined;
        const detail = step.detail ? capText(step.detail) : undefined;
        const ts = step.ts ? capText(step.ts) : undefined;
        truncated ||=
          label.truncated || !!kind?.truncated || !!detail?.truncated || !!ts?.truncated;
        return {
          label: label.value,
          ...(kind && { kind: kind.value }),
          ...(detail && { detail: detail.value }),
          ...(ts && { ts: ts.value }),
        };
      });
      if ((surface.steps?.length ?? 0) > TRACE_STEP_PREVIEW_LIMIT) truncated = true;
      return truncated
        ? {
            ...surface,
            ...(title && { title: title.value }),
            ...(steps && { steps }),
            truncated: true,
          }
        : surface;
    }
    case "json": {
      const serialized = JSON.stringify(surface.data);
      const { value, truncated } = capText(serialized);
      return truncated ? { ...surface, data: value, truncated: true } : surface;
    }
    default:
      return surface;
  }
}

export const recentSurfacePreviewView = (surface: Surface, index: number) => ({
  ...capSurface(surface),
  index,
});

export const recentPostRowView = (post: Post, session: Session | null | undefined) => {
  const surfaces = post.surfaces.map(recentSurfacePreviewView);
  return {
    id: post.id,
    sessionId: post.sessionId,
    sessionTitle: session?.title ?? null,
    agent: session?.agent ?? null,
    title: post.title,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    version: post.version,
    surfaces,
    parts: surfaces,
    partKinds: post.surfaces.map((surface) => surface.kind),
  };
};

export const feedbackView = (comment: Comment): Feedback => ({
  postId: comment.postId,
  postTitle: comment.postTitle,
  surfaceId: comment.postId,
  surfaceTitle: comment.postTitle,
  text: comment.text,
  at: comment.createdAt,
  ...(comment.anchor && { anchor: comment.anchor }),
});

export const sessionRowView = (session: Session, postCount: number) => ({
  ...session,
  postCount,
  surfaceCount: postCount,
});

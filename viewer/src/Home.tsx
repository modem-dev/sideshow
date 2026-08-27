import { createResource, For, onCleanup, Show } from "solid-js";
import { isSandboxedSurfaceKind, SURFACE_FRAME_CLASSES } from "../../server/types.ts";
import { appPath, getRecentPosts, relTime, type RecentPostRow, type RecentSurface } from "./api.ts";
import { activeTheme, resolvedMode } from "./theme.ts";
import { homeRefreshVersion, select } from "./state.ts";
import { StreamSkeleton } from "./Skeleton.tsx";

const previewFrames = new Set<HTMLIFrameElement>();

// The App-level bridge listener delegates Home resize messages here. This stays
// separate from Card's post-keyed registry: Home can show surfaces from several
// sessions, and two embedded engines can coexist in one module realm.
export function isHomePreviewFrame(source: unknown): boolean {
  for (const frame of previewFrames) {
    if (frame.contentWindow === source) return true;
  }
  return false;
}

export function resizeHomeFrame(source: unknown, height: unknown): boolean {
  if (!Number.isFinite(height)) return false;
  for (const frame of previewFrames) {
    if (frame.contentWindow === source) {
      frame.style.height = `${Math.min(240, Math.max(120, Math.round(height as number)))}px`;
      return true;
    }
  }
  return false;
}

function sessionTitle(post: RecentPostRow): string {
  return post.sessionTitle || (post.agent ? `${post.agent} session` : "Untitled session");
}

function partSummary(post: RecentPostRow): string {
  return post.partKinds.length === 0 ? "post" : post.partKinds.join(" · ");
}

function postHref(post: RecentPostRow): string {
  return appPath(`/session/${encodeURIComponent(post.sessionId)}/p/${encodeURIComponent(post.id)}`);
}

function surfaceSrc(post: RecentPostRow, surface: RecentSurface): string {
  return appPath(
    `/s/${encodeURIComponent(post.id)}?part=${surface.index}&ver=${post.version}&theme=${activeTheme()}&mode=${resolvedMode()}`,
  );
}

function JsonPreview(props: { surface: RecentSurface }) {
  const text = () =>
    JSON.stringify(props.surface.kind === "json" ? props.surface.data : null, null, 2);
  return <pre class="home-json-preview">{text()}</pre>;
}

function ImagePreview(props: {
  post: RecentPostRow;
  surface: Extract<RecentSurface, { kind: "image" }>;
}) {
  return (
    <img
      class="home-image-preview"
      src={appPath(`/a/${encodeURIComponent(props.surface.assetId)}`)}
      alt={props.surface.alt ?? props.post.title}
      loading="lazy"
    />
  );
}

function NativePreview(props: { post: RecentPostRow; surface: RecentSurface }) {
  const surface = () => props.surface;
  return (
    <Show
      when={
        surface().kind === "image" ? (surface() as Extract<RecentSurface, { kind: "image" }>) : null
      }
      fallback={
        <Show
          when={surface().kind === "json"}
          fallback={<div class="home-data-preview">{surface().kind} surface</div>}
        >
          <JsonPreview surface={surface()} />
        </Show>
      }
    >
      {(image) => <ImagePreview post={props.post} surface={image()} />}
    </Show>
  );
}

function SurfacePreview(props: { post: RecentPostRow; surface: RecentSurface }) {
  let frame: HTMLIFrameElement | undefined;
  onCleanup(() => {
    if (frame) previewFrames.delete(frame);
  });
  const surface = () => props.surface;
  return (
    <Show
      when={isSandboxedSurfaceKind(surface().kind)}
      fallback={<NativePreview post={props.post} surface={surface()} />}
    >
      <iframe
        class={`home-preview-frame ${SURFACE_FRAME_CLASSES[surface().kind] ?? ""}`}
        src={surfaceSrc(props.post, surface())}
        title={`${props.post.title} preview`}
        sandbox="allow-scripts"
        loading="lazy"
        aria-hidden="true"
        tabIndex={-1}
        ref={(el) => {
          frame = el;
          previewFrames.add(el);
        }}
      />
    </Show>
  );
}

function HomeCard(props: { post: RecentPostRow }) {
  const open = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    void select(props.post.sessionId, { initialPostId: props.post.id });
  };
  return (
    <a class="home-card" href={postHref(props.post)} onClick={open}>
      <div class="home-card-head">
        <span class="home-card-title">{props.post.title}</span>
        <span class="home-card-meta">{relTime(props.post.updatedAt)}</span>
      </div>
      <div class="home-card-sub">
        {sessionTitle(props.post)} · {partSummary(props.post)}
      </div>
      <Show when={props.post.surfaces[0]}>
        {(surface) => (
          <div class="home-previews" aria-hidden="true">
            <SurfacePreview post={props.post} surface={surface()} />
          </div>
        )}
      </Show>
      <div class="home-card-foot">View full post →</div>
    </a>
  );
}

export function HomeView() {
  const [recent] = createResource(homeRefreshVersion, () => getRecentPosts(30).catch(() => []));
  const posts = () => recent() ?? [];
  return (
    <section class="home-page" aria-label="Home">
      <header class="home-head">
        <h1>Home</h1>
        <p>Recent posts across your sideshow sessions.</p>
      </header>
      <Show when={!recent.loading} fallback={<StreamSkeleton />}>
        <Show
          when={posts().length > 0}
          fallback={
            <div class="home-empty">
              <h2>No posts yet</h2>
              <p>Open a session from the sidebar, or connect an agent to start publishing.</p>
            </div>
          }
        >
          <div class="home-feed">
            <For each={posts()}>{(post) => <HomeCard post={post} />}</For>
          </div>
        </Show>
      </Show>
    </section>
  );
}

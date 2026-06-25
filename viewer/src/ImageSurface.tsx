import { createSignal, Show } from "solid-js";
import type { ImageSurface as ImageSurfaceData } from "./api.ts";

// A trusted, viewer-chrome <img> for an uploaded asset (no iframe). The bytes
// live at /a/:id; an evicted/missing asset 404s, so show a placeholder rather
// than a broken image. Clicking opens the asset in a new tab.
export function ImageSurface(props: { surface: ImageSurfaceData }) {
  const [failed, setFailed] = createSignal(false);
  const src = () => `/a/${props.surface.assetId}`;
  return (
    <div class="image-surface">
      <Show
        when={!failed()}
        fallback={<div class="asset-gone">Image unavailable — it may have been evicted.</div>}
      >
        <a href={src()} target="_blank" rel="noopener">
          <img
            class="asset-img"
            src={src()}
            alt={props.surface.alt ?? props.surface.caption ?? "uploaded image"}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        </a>
        <Show when={props.surface.caption}>
          <div class="asset-caption">{props.surface.caption}</div>
        </Show>
      </Show>
    </div>
  );
}

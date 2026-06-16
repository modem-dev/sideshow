import { createSignal, Show } from "solid-js";
import type { ImagePart as ImagePartData } from "./api.ts";

// A trusted, viewer-chrome <img> for an uploaded asset (no iframe). The bytes
// live at /a/:id; an evicted/missing asset 404s, so show a placeholder rather
// than a broken image. Clicking opens the asset in a new tab.
export function ImagePart(props: { part: ImagePartData }) {
  const [failed, setFailed] = createSignal(false);
  const src = () => `/a/${props.part.assetId}`;
  return (
    <div class="imagepart">
      <Show
        when={!failed()}
        fallback={<div class="asset-gone">Image unavailable — it may have been evicted.</div>}
      >
        <a href={src()} target="_blank" rel="noopener">
          <img
            class="asset-img"
            src={src()}
            alt={props.part.alt ?? props.part.caption ?? "uploaded image"}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        </a>
        <Show when={props.part.caption}>
          <div class="asset-caption">{props.part.caption}</div>
        </Show>
      </Show>
    </div>
  );
}

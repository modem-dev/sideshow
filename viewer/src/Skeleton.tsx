import { Index, Show } from "solid-js";

const TITLE_WIDTHS = ["w40", "w25", "w55"];
const META_WIDTHS = ["w55", "w40", "w70"];
const BLOCK_HEIGHTS = [148, 92, 120];

export function ListSkeleton(props: {
  rows?: number;
  lines?: 1 | 2;
  avatar?: boolean;
  framed?: boolean;
}) {
  const rows = () => props.rows ?? 3;
  return (
    <div
      class="sk-rows"
      classList={{ "sk-framed": props.framed }}
      role="status"
      aria-label="Loading"
    >
      <Index each={Array.from({ length: rows() })}>
        {(_, i) => (
          <div class="sk-row" aria-hidden="true">
            <Show when={props.avatar !== false}>
              <span class="sk-av" />
            </Show>
            <span class="sk-row-text">
              <span class={`sk-line ${TITLE_WIDTHS[i % TITLE_WIDTHS.length]}`} />
              <Show when={(props.lines ?? 2) === 2}>
                <span class={`sk-line thin ${META_WIDTHS[i % META_WIDTHS.length]}`} />
              </Show>
            </span>
          </div>
        )}
      </Index>
    </div>
  );
}

export function StreamSkeleton(props: { cards?: number }) {
  const cards = () => props.cards ?? 3;
  return (
    <div class="sk-feed" role="status" aria-label="Loading posts">
      <Index each={Array.from({ length: cards() })}>
        {(_, i) => (
          <div class="sk-card" aria-hidden="true">
            <div class="sk-card-head">
              <span class="sk-row-text">
                <span class={`sk-line ${TITLE_WIDTHS[i % TITLE_WIDTHS.length]}`} />
                <span class={`sk-line thin ${META_WIDTHS[i % META_WIDTHS.length]}`} />
              </span>
            </div>
            <div
              class="sk-block"
              style={{ height: `${BLOCK_HEIGHTS[i % BLOCK_HEIGHTS.length]}px` }}
            />
          </div>
        )}
      </Index>
    </div>
  );
}

// Workspace column width, persisted server-side (PUT /api/width) like the theme;
// other open tabs follow via the width-changed SSE event (state.ts).
import { createSignal } from "solid-js";
import { api } from "./api.ts";
import type { LayoutWidth } from "../../server/types.ts";

const [wide, setWide] = createSignal(false);
export const isWide = wide;

// Apply locally, no round-trip (initial load + SSE). Unknown values mean normal.
export function applyWidth(value: string | undefined) {
  setWide(value === "wide");
}

export async function initWidth() {
  const res = await api<{ id: string }>("/api/width").catch(() => null);
  applyWidth(res?.id);
}

export async function setWidth(value: LayoutWidth) {
  applyWidth(value);
  await api("/api/width", { method: "PUT", body: JSON.stringify({ id: value }) }).catch(() => null);
}

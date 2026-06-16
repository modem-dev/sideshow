// Color tokens for STML. Agents are told to reach for semantic tokens
// (accent, success, danger…) rather than raw hex, so a snippet reads on a
// typical terminal without the agent guessing at the user's palette. Raw ANSI
// names ("cyan") and hex ("#38bdf8") also pass through.
//
// Pure (no opentui import): opentui's parseColor silently defaults invalid
// input to magenta instead of throwing, so we validate here and return null
// for anything unrecognized — the renderer then records a note and skips it,
// rather than painting a surprise magenta.

// Tuned to be legible on dark terminals (the common case) while staying
// readable on light ones. One palette: the terminal owns the background.
export const PALETTE: Record<string, string> = {
  accent: "#38bdf8",
  success: "#4ade80",
  warning: "#fbbf24",
  danger: "#f87171",
  info: "#60a5fa",
  muted: "#9ca3af",
  subtle: "#6b7280",
  heading: "#e5e7eb",
};

// ANSI names opentui understands, plus a couple of common CSS names.
const NAMED = new Set<string>([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "grey",
  "orange",
  ...["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].map(
    (n) => `bright${n}`,
  ),
]);

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const FUNC = /^(rgb|rgba|hsl|hsla)\(/;

// Resolve a token/name/hex to a string opentui accepts, or null if it is not
// a color we recognize (caller reports the note and skips the attribute).
export function resolveColor(value: string | undefined): string | null {
  if (!value) return null;
  const token = value.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PALETTE, token)) return PALETTE[token];
  if (HEX.test(token) || NAMED.has(token) || FUNC.test(token)) return token;
  return null;
}

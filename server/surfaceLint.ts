// Advisory publish-time lint for surfaces. The one firm design rule is "dark
// mode is mandatory" (guide/DESIGN_GUIDE.md): an html surface must drive every
// color from the --color-* theme tokens so it adapts to the board's light/dark
// scheme. An agent that hardcodes a hex/rgb color instead renders washed-out on
// a board in the opposite scheme (e.g. a `background:#fff` note on a dark board).
// The renderer can't fix this — it can't tell an accidental light card from a
// deliberate one — so the publish path flags it back to the author as a
// non-blocking warning. It never rejects: an intentional light/dark design is
// flagged too, and the agent is free to ignore it.
import type { Surface } from "./types.ts";

// Adaptiveness-critical CSS properties. A hardcoded value on one of these is
// what makes a surface ignore the board scheme. Deliberately limited to
// background + text: SVG fill/stroke and decorative borders carry literal colors
// far more often without breaking adaptiveness, so including them would mostly
// add false positives.
const SCHEME_PROPS = ["background", "background-color", "color"];

// A literal color value: hex, rgb()/rgba(), hsl()/hsla(), or the two named
// colors that actually break a scheme (white/black). A value that reads a theme
// token (var(--…)) is adaptive by construction and never flagged — including
// `var(--x, #fff)`, where the hardcoded hex is only a last-resort fallback.
const LITERAL_COLOR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:white|black)\b/i;

// Pull hardcoded scheme colors out of an html surface's markup. Scans both
// inline `style="…"` attributes and `<style>…</style>` rules for a
// background/color declaration whose value is a literal (and not a var()).
// Returns the offending declarations, deduped and capped, for the warning text.
export function findHardcodedColors(html: string): string[] {
  // The leading lookbehind keeps `border-color` / `caret-color` from matching as
  // `color` (and `-background` from matching `background`).
  const decl = new RegExp(`(?<![\\w-])(${SCHEME_PROPS.join("|")})\\s*:\\s*([^;"'{}]+)`, "gi");
  const hits: string[] = [];
  for (let m = decl.exec(html); m; m = decl.exec(html)) {
    const value = m[2].trim();
    if (value.includes("var(")) continue; // token-driven → adaptive
    if (!LITERAL_COLOR.test(value)) continue;
    const text = `${m[1].toLowerCase()}: ${value}`.slice(0, 60);
    if (!hits.includes(text)) hits.push(text);
    if (hits.length >= 4) break;
  }
  return hits;
}

// One advisory warning per html surface that hardcodes scheme colors. Other
// kinds (markdown/code/diff/mermaid/terminal) are themed by the trusted renderer
// — markdown even escapes raw HTML — so they can't carry an applied hardcoded
// color; they're skipped.
export function lintSurfaces(parts: Surface[]): string[] {
  const warnings: string[] = [];
  parts.forEach((part, i) => {
    if (part.kind !== "html") return;
    const hits = findHardcodedColors(part.html);
    if (hits.length === 0) return;
    const where = parts.length > 1 ? `surface ${i + 1}` : "surface";
    warnings.push(
      `${where} hardcodes colors (${hits.join(", ")}) — drive color from the ` +
        `--color-* theme tokens so it adapts to light/dark; hardcoded colors render ` +
        `washed-out on a board in the opposite scheme.`,
    );
  });
  return warnings;
}

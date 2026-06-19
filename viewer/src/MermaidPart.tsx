import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { MermaidPart as MermaidPartData } from "./api.ts";
import { SandboxedPart } from "./SandboxedPart.tsx";
import { activeTheme } from "./theme.ts";

// Wrapper styles shipped into the sandbox iframe. Mermaid bakes theme colors
// into the SVG itself (read from the trusted viewer's vars at render time), so
// the iframe only needs to center and constrain it.
const MERMAID_CSS = `
body { margin: 0; padding: 14px 16px; background: transparent; text-align: center; }
svg { max-width: 100%; height: auto; }
`;

// Mermaid bakes theme colors into the SVG at render time (unlike shiki's
// dual-theme output, which a CSS rule can flip), so the diagram must be
// re-rendered when the OS color scheme changes OR the board theme switches.
// Reuse the same prefers-color-scheme signal pattern DiffPart uses.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const [isDark, setIsDark] = createSignal(darkQuery.matches);
darkQuery.addEventListener("change", (e) => setIsDark(e.matches));

// mermaid.render namespaces the SVG's internal ids with this; it must be unique
// per render across the whole document, so a module-level counter, not a uuid.
let seq = 0;

// Mermaid's stock themes ignore our design tokens, so the diagram reads as
// generic mermaid. Instead drive its `base` theme from the viewer's own CSS
// custom properties (read live — this part renders in the trusted origin, so
// getComputedStyle is fine). The vars already flip light/dark, so re-rendering
// on a scheme change (below) is all that's needed to stay in sync. Returns the
// `themeVariables` + `themeCSS` mermaid needs to match sideshow's look.
function sideshowTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;

  const text = v("--text", "#1a1915");
  const muted = v("--muted", "#5f5e56");
  const border = v("--border-2", "rgba(20,20,10,0.25)");
  const panel = v("--panel", "#f3f2ec");
  const surface = v("--surface", "#ffffff");
  const bg = v("--bg", "#faf9f5");
  const accent = v("--accent", "#185fa5");
  const accentBg = v("--accent-bg", "#e6f1fb");
  // The viewer has no font token — its system stack lives on `body` — so match
  // the diagram font to whatever the rest of the viewer is actually rendering.
  const font = getComputedStyle(document.body).fontFamily || "ui-sans-serif, system-ui, sans-serif";

  return {
    themeVariables: {
      fontFamily: font,
      fontSize: "14px",
      // shared / flowchart
      primaryColor: panel,
      primaryBorderColor: border,
      primaryTextColor: text,
      secondaryColor: surface,
      tertiaryColor: bg,
      mainBkg: panel,
      nodeBorder: border,
      lineColor: muted,
      textColor: text,
      clusterBkg: bg,
      clusterBorder: border,
      edgeLabelBackground: bg,
      // sequence diagrams have their own palette
      actorBkg: panel,
      actorBorder: border,
      actorTextColor: text,
      actorLineColor: muted,
      signalColor: muted,
      signalTextColor: text,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: border,
      labelTextColor: text,
      loopTextColor: text,
      noteBkgColor: accentBg,
      noteBorderColor: border,
      noteTextColor: text,
      sequenceNumberColor: surface,
    },
    // Flat-and-clean to match the design language: rounded rects, hairline
    // strokes, no heavy borders. Plus agent-facing accent classes (see below).
    themeCSS: `
      .node rect, .node polygon, rect.actor, .labelBox { rx: 8px; ry: 8px; }
      .node rect, rect.actor { stroke-width: 1px; }
      .edgePath .path, .flowchart-link, .actor-line,
      .messageLine0, .messageLine1 { stroke-width: 1px; }

      /* Agent-applied highlight classes, colored from --accent. Apply in a
         flowchart with A:::accent (a node) or 'class A,B accent'. 'accent'
         fills a node with the brand color; 'accentLine' recolors an edge
         (pair with linkStyle to target a specific link). */
      .node.accent > rect, .node.accent > polygon, .node.accent > circle,
      .node.accent > path { fill: ${accentBg}; stroke: ${accent}; }
      .node.accent .nodeLabel, .node.accent span, .node.accent text { fill: ${accent}; color: ${accent}; }
      .flowchart-link.accentLine, .edgePath.accentLine > .path { stroke: ${accent}; }
    `,
  };
}

export function MermaidPart(props: { part: MermaidPartData }) {
  const [svg, setSvg] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    let disposed = false;
    onCleanup(() => (disposed = true));

    const render = async () => {
      const src = props.part.mermaid ?? "";
      try {
        // Lazy-load mermaid (a heavy dep) only when a mermaid part actually
        // mounts. mermaid is the default export.
        const mermaid = (await import("mermaid")).default;
        // securityLevel 'strict' makes mermaid sanitize the generated SVG with
        // its bundled DOMPurify and disables inline HTML labels and click
        // handlers — this part renders in the trusted viewer origin (no
        // sandbox), so never relax it. suppressErrorRendering keeps a parse
        // failure from injecting mermaid's "bomb" graphic into document.body;
        // we render our own error fallback instead.
        const { themeVariables, themeCSS } = sideshowTheme();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: "base",
          themeVariables,
          themeCSS,
        });
        const { svg: out } = await mermaid.render(`mmd-${seq++}`, src);
        if (!disposed) {
          setError(null);
          setSvg(out);
        }
      } catch (e) {
        if (!disposed) {
          setSvg("");
          setError(e instanceof Error ? e.message : "Could not render diagram.");
        }
      }
    };

    // Initial paint, plus a re-render whenever the color scheme flips or the
    // board theme changes: the effect reads both signals synchronously (so
    // they're tracked), then renders with the current palette. applyTheme
    // injects the chrome vars before activeTheme() updates, so the
    // getComputedStyle in sideshowTheme() already sees the new values. The
    // first run does the initial paint.
    createEffect(() => {
      isDark();
      activeTheme();
      void render();
    });
  });

  return (
    <div class="mermaidpart">
      {error() ? (
        <div class="mermaid-error">
          Couldn&rsquo;t render diagram — {error()}
          <pre>{props.part.mermaid}</pre>
        </div>
      ) : (
        // The SVG string is produced here (trusted), then parsed inside an
        // opaque-origin iframe — a second boundary behind mermaid's DOMPurify.
        <SandboxedPart class="partframe mermaidframe" body={svg()} css={MERMAID_CSS} />
      )}
    </div>
  );
}

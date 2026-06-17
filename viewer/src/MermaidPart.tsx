import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { MermaidPart as MermaidPartData } from "./api.ts";

// Mermaid bakes theme colors into the SVG at render time (unlike shiki's
// dual-theme output, which a CSS rule can flip), so the diagram must be
// re-rendered when the OS color scheme changes. Reuse the same
// prefers-color-scheme signal pattern DiffPart uses.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const [isDark, setIsDark] = createSignal(darkQuery.matches);
darkQuery.addEventListener("change", (e) => setIsDark(e.matches));

// mermaid.render namespaces the SVG's internal ids with this; it must be unique
// per render across the whole document, so a module-level counter, not a uuid.
let seq = 0;

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
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: isDark() ? "dark" : "default",
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

    // Initial paint, plus a re-render whenever the color scheme flips: the
    // effect reads isDark() synchronously (so it's tracked), then renders with
    // the matching mermaid theme. The first run does the initial paint.
    createEffect(() => {
      isDark();
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
        // eslint-disable-next-line solid/no-innerhtml -- sanitized: mermaid securityLevel 'strict' (DOMPurify)
        <div class="mermaid-svg" innerHTML={svg()}></div>
      )}
    </div>
  );
}

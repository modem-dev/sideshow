import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Builds the embeddable engine: viewer/src/embed.tsx -> viewer/dist-embed/
// engine.js, a self-contained ESM bundle (own Solid runtime baked in) the host
// imports and calls mountViewer() from. Distinct from the singlefile build,
// which inlines the self-hosted index.html.
export default defineConfig({
  root: "viewer",
  plugins: [solid()],
  build: {
    outDir: "dist-embed",
    emptyOutDir: true,
    target: "es2022",
    lib: {
      entry: "src/embed.tsx",
      formats: ["es"],
      fileName: () => "engine.js",
    },
  },
});

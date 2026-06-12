import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import solid from "vite-plugin-solid";

// Builds viewer/ into a single self-contained viewer/dist/index.html — the
// server keeps serving the viewer as one in-memory document on both runtimes
// (Node readFile, Workers Text-rule import), so no static-asset routes exist.
export default defineConfig({
  root: "viewer",
  plugins: [solid(), viteSingleFile()],
  build: {
    target: "es2022",
    emptyOutDir: true,
  },
});

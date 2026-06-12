import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Each test boots `node server/index.ts`, which serves viewer/dist/index.html
// read at startup — build the viewer once before the suite runs.
export default function globalSetup() {
  execSync("npx vite build", {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
  });
}

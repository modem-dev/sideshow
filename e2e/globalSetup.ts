import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Each test boots `node server/index.ts`, which serves viewer/dist/index.html
// read at startup — build the viewer once before the suite runs. The embed e2e
// also mounts the embeddable engine bundle (viewer/dist-embed), so build that too.
export default function globalSetup() {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  execSync("npx vite build", { cwd, stdio: "inherit" });
  execSync("npx vite build -c viewer/vite.embed.config.ts", { cwd, stdio: "inherit" });
}

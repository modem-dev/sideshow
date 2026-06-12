import { defineConfig, devices } from "@playwright/test";

// Viewer e2e suite — runs with `npm run test:e2e`, kept out of `npm test`.
// WebKit is the point: the iframe resize bridge has WebKit-specific quirks
// (see CLAUDE.md), so both engines must pass.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/globalSetup.ts",
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});

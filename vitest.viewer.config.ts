import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "jsdom",
    include: ["viewer/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["viewer/src/**/*.{ts,tsx}"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/viewer",
      // Percentage points, not fractions: these intentionally tiny floors pin
      // the honest all-viewer baseline until component unit coverage grows.
      thresholds: {
        statements: 0.9,
        branches: 0.7,
        functions: 0.5,
        lines: 1.3,
      },
    },
  },
});

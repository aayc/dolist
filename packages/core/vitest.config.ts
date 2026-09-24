import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../scripts/vitest/setup-fast-check.ts"],
  },
});

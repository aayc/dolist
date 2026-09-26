import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../scripts/vitest/setup-fast-check.ts"],
    // Test files share modules within a worker (imports dominate this suite's time): a test must
    // not leave module-level state behind for the next file.
    isolate: false,
  },
});

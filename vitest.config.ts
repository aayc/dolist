import { defineConfig } from "vitest/config";

/**
 * Every package's tests as one run, for `pnpm test:changed` (Vitest's `--changed`: only the tests
 * that import what changed). `pnpm test` runs each package on its own through turbo instead.
 */
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts", "evals/vitest.config.ts"],
  },
});

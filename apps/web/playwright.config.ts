import { defineConfig } from "@playwright/test";
import { E2E_PORT } from "./e2e/ports.ts";

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [["github"], ["list"]] : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Local runs use the installed Google Chrome; CI installs Playwright's bundled Chromium.
    ...(CI ? {} : { channel: "chrome" }),
  },
  // No device preset: its spoofed user agent would make the app pick the wrong "Mod" key
  // (⌘ vs Ctrl) relative to Playwright's host-based ControlOrMeta.
  projects: [
    {
      name: "functional",
      testMatch: /\.spec\.ts$/,
      testIgnore: /[\\/]perf[\\/]/,
      fullyParallel: true,
      use: { viewport: { width: 1400, height: 900 } },
    },
    {
      name: "perf",
      testMatch: /[\\/]perf[\\/].*\.spec\.ts$/,
      fullyParallel: false,
      use: {
        viewport: { width: 1400, height: 900 },
        // Frames are produced as soon as work is done instead of on the next 60Hz vsync, so
        // "event → next frame" metrics measure the app's work rather than the refresh phase
        // (which alone puts p95 at ~16ms).
        launchOptions: { args: ["--disable-frame-rate-limit", "--disable-gpu-vsync"] },
      },
    },
  ],
  // Real daemons on demand (e2e/fixtures.ts), each serving the app built here.
  webServer: {
    command: `pnpm exec vite build && pnpm --filter @ddl/agent exec tsx scripts/e2e-daemons.ts --port=${E2E_PORT}`,
    url: `http://127.0.0.1:${E2E_PORT}`,
    reuseExistingServer: !CI,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});

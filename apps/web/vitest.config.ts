import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { EXCALIDRAW_ASSET_DIR } from "./excalidraw-assets.ts";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __EXCALIDRAW_ASSET_DIR__: JSON.stringify(EXCALIDRAW_ASSET_DIR),
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    restoreMocks: true,
    setupFiles: ["../../scripts/vitest/setup-fast-check.ts"],
  },
});

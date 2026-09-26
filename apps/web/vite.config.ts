import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";
import { EXCALIDRAW_ASSET_DIR, excalidrawAssets } from "./excalidraw-assets.ts";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** `pnpm dev:mock` moves it (DDL_WEB_PORT) so it runs beside `pnpm dev`. */
const DEV_PORT = Number(process.env.DDL_WEB_PORT ?? 5173);
const daemonOrigin = `http://127.0.0.1:${process.env.DDL_PORT ?? "7331"}`;
const devOrigins = new Set([`http://localhost:${DEV_PORT}`, `http://127.0.0.1:${DEV_PORT}`]);

/** Read on every request so a restarted daemon (new token) works without restarting Vite. */
function readDaemonToken(): string | null {
  const home = process.env.DDL_HOME ?? join(homedir(), ".daily-do-list");
  try {
    return readFileSync(join(home, "daemon-token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Only requests made by the dev UI itself get the token: the proxy must not let other websites
 * borrow the daemon's credentials (cross-site requests carry a foreign Origin / Sec-Fetch-Site).
 */
function isTrustedDevRequest(headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  if (origin !== undefined && !devOrigins.has(origin)) return false;
  const site = headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

function authorize(
  proxyReq: { setHeader(name: string, value: string): void },
  headers: IncomingHttpHeaders,
): void {
  if (!isTrustedDevRequest(headers)) return;
  // The daemon only accepts its own origin; the trusted dev origin is presented as the daemon's.
  if (headers.origin !== undefined) proxyReq.setHeader("origin", daemonOrigin);
  const token = readDaemonToken();
  if (token) proxyReq.setHeader("authorization", `Bearer ${token}`);
}

const withDaemonAuth: ProxyOptions["configure"] = (proxy) => {
  proxy.on("proxyReq", (proxyReq, req) => authorize(proxyReq, req.headers));
  proxy.on("proxyReqWs", (proxyReq, req) => authorize(proxyReq, req.headers));
};

export default defineConfig({
  plugins: [react(), excalidrawAssets()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __EXCALIDRAW_ASSET_DIR__: JSON.stringify(EXCALIDRAW_ASSET_DIR),
  },
  server: {
    host: "127.0.0.1",
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      "/api": { target: daemonOrigin, changeOrigin: true, configure: withDaemonAuth },
      "/ws": { target: daemonOrigin, ws: true, changeOrigin: true, configure: withDaemonAuth },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
    // Read by scripts/bundle-size-check.mjs to compute the initial (entry + static imports) size.
    manifest: true,
    rolldownOptions: {
      output: {
        // Stable vendor chunks (Rolldown's successor to Rollup's manualChunks). `$initial` keeps
        // lazily-loaded code (e.g. CodeMirror language packs) out of the startup chunks.
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              tags: ["$initial"],
              priority: 3,
            },
            {
              name: "codemirror",
              test: /node_modules[\\/](@codemirror|@lezer|@replit|style-mod|w3c-keyname|crelt)[\\/]/,
              tags: ["$initial"],
              priority: 2,
            },
            {
              name: "markdown",
              test: /node_modules[\\/](marked|dompurify)[\\/]/,
              priority: 1,
            },
          ],
        },
      },
    },
  },
});

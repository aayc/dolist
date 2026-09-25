// Bundles the sync server, its workspace packages and its third-party dependencies into one file,
// dist/main.js, so self-hosting needs Node 24 and that file (plus its source map) only.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const syncDir = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(syncDir, "src/main.ts")],
  outfile: resolve(syncDir, "dist/main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  legalComments: "linked",
  logLevel: "info",
  // Optional native speedups of `ws`; it falls back to JavaScript without them.
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    // Shebang for the `ddl-sync` bin; `require` lets bundled CommonJS code (ws) keep working.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __ddlCreateRequire } from "node:module";',
      "const require = __ddlCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

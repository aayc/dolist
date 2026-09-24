// Bundles the daemon and the workspace packages it uses into dist/main.js. Third-party runtime
// dependencies stay external: the daemon declares every one of them (versions shared through the
// pnpm catalog), so bare imports resolve from apps/daemon/node_modules at runtime.
//
// Code splitting keeps startup fast: modules reached only through `import()` (the agent runtime,
// the Pi harness) land in dist/chunks/ and load on first use, so their external dependencies
// aren't hoisted into main.js and loaded before the daemon can answer.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const daemonDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(daemonDir, "../..");

/** Workspace packages that end up in the bundle. */
const BUNDLED_PACKAGES = [
  "apps/daemon",
  "packages/agent",
  "packages/storage",
  "packages/connectors",
  "packages/contract",
  "packages/core",
];

function dependenciesOf(dir) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, dir, "package.json"), "utf8"));
  return Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith("@ddl/"));
}

const daemonDependencies = new Set(dependenciesOf("apps/daemon"));
const missing = BUNDLED_PACKAGES.flatMap((dir) =>
  dependenciesOf(dir)
    .filter((name) => !daemonDependencies.has(name))
    .map((name) => `${name} (from ${dir})`),
);
if (missing.length > 0) {
  console.error(
    `apps/daemon/package.json must also declare these runtime dependencies (use "catalog:"):\n  ${missing.join("\n  ")}`,
  );
  process.exit(1);
}

/**
 * Loaded on first use only: Pi from its own chunk (`import("./harness/pi")`), Playwright via
 * `import()` at the call site. Statically imported from anywhere else, they would load before the
 * daemon answers (~500 ms on every start).
 */
const PI_HARNESS_ENTRY = "packages/agent/src/harness/pi.ts";
const LAZY_DEPENDENCY = /^(?:@earendil-works\/|playwright-core)/;

const result = await build({
  metafile: true,
  entryPoints: [resolve(daemonDir, "src/main.ts")],
  outdir: resolve(daemonDir, "dist"),
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
  external: [...daemonDependencies],
  banner: {
    // Shebang for the `daily-do-list` bin; `require` lets bundled CommonJS-style code keep working.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __ddlCreateRequire } from "node:module";',
      "const require = __ddlCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

const eager = Object.entries(result.metafile.outputs).flatMap(([file, output]) => {
  const isPiChunk = output.entryPoint?.endsWith(PI_HARNESS_ENTRY) ?? false;
  return output.imports
    .filter((entry) => entry.kind === "import-statement" && LAZY_DEPENDENCY.test(entry.path))
    .filter((entry) => !(isPiChunk && entry.path.startsWith("@earendil-works/")))
    .map((entry) => `${file}: ${entry.path}`);
});
if (eager.length > 0) {
  console.error(
    `These dependencies must load on first use (import()), not with the daemon:\n  ${[...new Set(eager)].join("\n  ")}`,
  );
  process.exit(1);
}

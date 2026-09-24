// Bundles the daemon and the workspace packages it uses into dist/main.js. Third-party runtime
// dependencies stay external: the daemon declares every one of them (versions shared through the
// pnpm catalog), so bare imports resolve from apps/daemon/node_modules at runtime.
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

await build({
  entryPoints: [resolve(daemonDir, "src/main.ts")],
  outfile: resolve(daemonDir, "dist/main.js"),
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

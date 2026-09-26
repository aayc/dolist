#!/usr/bin/env node
/**
 * The quick loop: checks what changed since `<base>` (default main: commits since the branch
 * point, staged, unstaged and untracked files).
 *
 *   pnpm check:changed [<base>]   lint and secret-scan the changed files, typecheck (turbo replays
 *                                 the packages that didn't change), then the tests below
 *   pnpm test:changed [<base>]    only the tests that import a changed file, in every package
 *                                 (Vitest's --changed over the projects in vitest.config.ts; a
 *                                 changed config, setup file or package.json runs them all)
 *
 * `pnpm check` stays the full gate: every lint, every package's tests.
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const testsOnly = args.includes("--tests-only");
const base = args.find((arg) => !arg.startsWith("--")) ?? "main";

const steps = [
  ...(testsOnly
    ? []
    : [
        ["lint", ["node", "scripts/lint.mjs", "--changed", base]],
        ["secrets", ["node", "scripts/check-secrets.mjs", "--all"]],
        ["typecheck", ["pnpm", "-s", "typecheck", "--output-logs=errors-only"]],
      ]),
  ["tests", ["pnpm", "exec", "vitest", "run", "--changed", base, "--passWithNoTests"]],
];

for (const [name, [command, ...rest]] of steps) {
  const started = performance.now();
  const result = spawnSync(command, rest, { stdio: "inherit" });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`✖ ${name} failed (${seconds}s)`);
    process.exit(result.status ?? 1);
  }
  if (!testsOnly) console.log(`✔ ${name} (${seconds}s)`);
}

#!/usr/bin/env node
/**
 * Every linter and formatter check, over the staged files (the pre-commit hook) or the whole
 * repository (`pnpm lint`, CI). Secrets are scanned separately: scripts/check-secrets.mjs and
 * gitleaks, in the hooks and in CI.
 *
 *   node scripts/lint.mjs --staged | --all [--fix] [--only <names>] [--skip <names>]
 *
 *   hygiene     conflict markers, line endings, whitespace, big files, case-colliding paths,
 *               executable bits, relative Markdown links (scripts/check-hygiene.mjs)
 *   biome       TypeScript, JavaScript, JSON, CSS: lint + format (biome.json)
 *   shellcheck  shell scripts and git hooks
 *   actionlint  GitHub workflows, including the shell in their `run:` steps
 *   vectors     the Swift test vectors still match the TypeScript core (when their inputs change)
 *
 * `--fix` applies Biome's fixes and regenerates the vectors. A missing external tool is skipped
 * with a warning locally (`brew install shellcheck actionlint`) and fails the run in CI.
 */
import { execFileSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const mode = args.includes("--all") ? "all" : "staged";
const fix = args.includes("--fix") && mode === "all";
const names = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? "").split(",").filter(Boolean);
};
const only = names("--only");
const skip = names("--skip") ?? [];

const files = execFileSync(
  "git",
  mode === "all"
    ? ["ls-files", "-co", "--exclude-standard", "-z"]
    : ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
  { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
)
  .split("\0")
  .filter(Boolean);

const CHECKS = [
  {
    name: "hygiene",
    command: () => ["node", "scripts/check-hygiene.mjs", `--${mode}`],
  },
  {
    name: "biome",
    command: () =>
      mode === "all"
        ? ["pnpm", "exec", "biome", "check", ...(fix ? ["--write"] : []), "."]
        : [
            "pnpm",
            "exec",
            "biome",
            "check",
            "--staged",
            "--no-errors-on-unmatched",
            "--files-ignore-unknown=true",
          ],
  },
  {
    name: "shellcheck",
    tool: "shellcheck",
    matches: (f) => /(\.sh$|^\.githooks\/[^/]+$)/.test(f),
    command: (matched) => ["shellcheck", ...matched],
  },
  {
    name: "actionlint",
    tool: "actionlint",
    // A changed local action can break the workflows that use it, so lint them all.
    matches: (f) => /^\.github\/(workflows|actions)\/.+\.ya?ml$/.test(f),
    command: () => ["actionlint"],
  },
  {
    name: "vectors",
    matches: (f) =>
      /^(packages\/core\/src\/|apps\/macos\/scripts\/(vectors\/|generate-vectors\.ts$)|apps\/macos\/Packages\/DailyDoListDomain\/Tests\/DailyDoListDomainTests\/Vectors\/)/.test(
        f,
      ),
    command: () => ["pnpm", "-s", fix ? "vectors" : "vectors:check"],
  },
];

function installed(tool) {
  return !spawnSync(tool, ["--version"], { stdio: "ignore" }).error;
}

const ran = [];
const failed = [];
const skipped = [];
for (const check of CHECKS) {
  if ((only && !only.includes(check.name)) || skip.includes(check.name)) continue;
  const matched = check.matches ? files.filter(check.matches) : files;
  if (check.matches && matched.length === 0) continue;
  if (check.tool && !installed(check.tool)) {
    if (process.env.CI) failed.push(`${check.name} (${check.tool} is not installed)`);
    else skipped.push(check.tool);
    continue;
  }
  const [command, ...rest] = check.command(matched);
  const result = spawnSync(command, rest, { stdio: "inherit" });
  ran.push(check.name);
  if (result.status !== 0) failed.push(check.name);
}

if (skipped.length > 0) {
  console.warn(
    `⚠ lint: skipped ${skipped.join(", ")}: not installed (brew install ${skipped.join(" ")})`,
  );
}
if (failed.length > 0) {
  console.error(`✖ lint: ${failed.join(", ")} failed`);
  process.exit(1);
}
const summary = ran.length > 0 ? `${ran.join(", ")} ok` : "nothing to check";
console.log(`✔ lint: ${summary} (${mode}, ${files.length} file(s))`);

#!/usr/bin/env node
/**
 * Every linter and formatter check, over the staged files (the pre-commit hook), what changed since
 * a revision (`pnpm check:changed`) or the whole repository (`pnpm lint`, CI). Secrets are scanned
 * separately: scripts/check-secrets.mjs and gitleaks, in the hooks and in CI.
 *
 *   node scripts/lint.mjs --staged | --changed [<base>] | --all [--fix] [--only <names>] [--skip <names>]
 *
 *   hygiene     conflict markers, line endings, whitespace, big files, case-colliding paths,
 *               executable bits, relative Markdown links (scripts/check-hygiene.mjs)
 *   biome       TypeScript, JavaScript, JSON, CSS: lint + format (biome.json)
 *   swift       Swift: swift-format's formatting and lint rules (.swift-format)
 *   shellcheck  shell scripts and git hooks
 *   actionlint  GitHub workflows, including the shell in their `run:` steps
 *   vectors     the Swift test vectors still match the TypeScript core (when their inputs change)
 *
 * `--changed` takes what differs from `<base>` (default main): commits since the branch point,
 * staged, unstaged and untracked files; hygiene always checks the whole repository (it's quick).
 * `--fix` applies Biome's fixes, formats Swift and regenerates the vectors. A missing external
 * tool is skipped with a warning locally and fails the run in CI. Checks run in parallel (in
 * order with `--fix`). Locally, `--all` skips swift-format while no Swift file changed since it
 * last passed (the slowest check; node_modules/.cache/ddl-lint).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = args.includes("--all") ? "all" : args.includes("--changed") ? "changed" : "staged";
const fix = args.includes("--fix") && mode === "all";
const names = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? "").split(",").filter(Boolean);
};
const only = names("--only");
const skip = names("--skip") ?? [];

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);

function changedFiles() {
  const next = args[args.indexOf("--changed") + 1];
  const base = next && !next.startsWith("--") ? next : "main";
  const files = new Set([
    ...git("diff", "--name-only", "--diff-filter=ACMR", "-z", `${base}...HEAD`),
    ...git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"),
    ...git("ls-files", "--others", "--modified", "--exclude-standard", "-z"),
  ]);
  return [...files].filter((file) => existsSync(file));
}

const files =
  mode === "all"
    ? git("ls-files", "-co", "--exclude-standard", "-z")
    : mode === "changed"
      ? changedFiles()
      : git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z");

const CACHE_DIR = "node_modules/.cache/ddl-lint";
const SWIFT_VERSION = ["swift", "format", "--version"];

/** A key for the Swift sources, their config and the formatter, or null when not cacheable. */
function swiftCacheKey(matched) {
  if (mode !== "all" || fix || process.env.CI) return null;
  const hash = createHash("sha256");
  hash.update(spawnSync(SWIFT_VERSION[0], SWIFT_VERSION.slice(1), { encoding: "utf8" }).stdout);
  for (const file of [".swift-format", ...matched]) {
    hash.update(`\0${file}\0`);
    if (existsSync(file)) hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

const CHECKS = [
  {
    name: "hygiene",
    command: () => ["node", "scripts/check-hygiene.mjs", mode === "staged" ? "--staged" : "--all"],
  },
  {
    name: "biome",
    command: (matched) =>
      mode === "all"
        ? ["pnpm", "exec", "biome", "check", ...(fix ? ["--write"] : []), "."]
        : mode === "changed"
          ? [
              "pnpm",
              "exec",
              "biome",
              "check",
              "--no-errors-on-unmatched",
              "--files-ignore-unknown=true",
              ...matched,
            ]
          : [
              "pnpm",
              "exec",
              "biome",
              "check",
              "--staged",
              "--no-errors-on-unmatched",
              "--files-ignore-unknown=true",
            ],
    // Biome gets no file list in `changed` mode when nothing changed; there's nothing to check.
    matches: mode === "changed" ? () => true : undefined,
  },
  {
    name: "swift",
    tool: { probe: SWIFT_VERSION, install: "xcode-select --install" },
    matches: (f) => f.endsWith(".swift"),
    cacheKey: swiftCacheKey,
    command: (matched) =>
      fix
        ? ["swift", "format", "format", "--in-place", "--parallel", ...matched]
        : ["swift", "format", "lint", "--strict", "--parallel", ...matched],
  },
  {
    name: "shellcheck",
    tool: { probe: ["shellcheck", "--version"], install: "brew install shellcheck" },
    matches: (f) => /(\.sh$|^\.githooks\/[^/]+$)/.test(f),
    command: (matched) => ["shellcheck", ...matched],
  },
  {
    name: "actionlint",
    tool: { probe: ["actionlint", "--version"], install: "brew install actionlint" },
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

function installed({ probe: [command, ...rest] }) {
  const result = spawnSync(command, rest, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

/** Runs a check with its output buffered, so parallel checks print one after another. */
function run([command, ...rest]) {
  return new Promise((resolve) => {
    const child = spawn(command, rest, { stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.on("error", (error) => resolve({ status: 1, output: `${error.message}\n` }));
    child.on("close", (status) => resolve({ status, output: Buffer.concat(output).toString() }));
  });
}

const ran = [];
const failed = [];
const skipped = [];
const cached = [];
const jobs = [];
for (const check of CHECKS) {
  if ((only && !only.includes(check.name)) || skip.includes(check.name)) continue;
  const matched = check.matches ? files.filter(check.matches) : files;
  if (check.matches && matched.length === 0) continue;
  if (check.tool && !installed(check.tool)) {
    if (process.env.CI) failed.push(`${check.name} (${check.tool.probe[0]} is not installed)`);
    else skipped.push(`${check.name} (${check.tool.install})`);
    continue;
  }
  const key = check.cacheKey?.(matched) ?? null;
  const stamp = `${CACHE_DIR}/${check.name}`;
  if (key && existsSync(stamp) && readFileSync(stamp, "utf8") === key) {
    cached.push(check.name);
    continue;
  }
  ran.push(check.name);
  const job = async () => {
    const result = await run(check.command(matched));
    if (result.status !== 0) failed.push(check.name);
    else if (key) {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(stamp, key);
    }
    return result;
  };
  jobs.push(job);
}

if (fix) {
  for (const job of jobs) process.stdout.write((await job()).output);
} else {
  for (const result of await Promise.all(jobs.map((job) => job()))) {
    process.stdout.write(result.output);
  }
}

if (skipped.length > 0) console.warn(`⚠ lint: not installed, skipped: ${skipped.join(", ")}`);
if (failed.length > 0) {
  console.error(`✖ lint: ${failed.join(", ")} failed`);
  process.exit(1);
}
const parts = [...ran, ...cached.map((name) => `${name} (unchanged)`)];
const summary = parts.length > 0 ? `${parts.join(", ")} ok` : "nothing to check";
console.log(`✔ lint: ${summary} (${mode}, ${files.length} file(s))`);

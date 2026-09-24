#!/usr/bin/env node
/**
 * Benchmark gate. Every package with a `bench` script writes `bench-results.json` (Vitest JSON
 * reporter). Budgets are asserted inside the `*.bench.ts` tests (scaled by BENCH_BUDGET_MULTIPLIER),
 * so a blown budget surfaces here as a failed test. Prints a table (also to the GitHub job summary)
 * and exits 1 if any benchmark failed or no results were found.
 *
 *   pnpm bench && pnpm bench:check
 *   node scripts/bench-check.mjs [dir...]   # search only these directories
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { findFiles, markdownTable, REPO_ROOT, textTable, writeStepSummary } from "./lib/report.mjs";

const DEFAULT_SEARCH_ROOTS = ["packages", "apps"];
const RESULTS_FILE = "bench-results.json";

const COLUMNS = [
  { header: "Package" },
  { header: "Benchmark" },
  { header: "p50 ms", align: "right" },
  { header: "p99 ms", align: "right" },
  { header: "Samples", align: "right" },
  { header: "Status" },
];

const STATUS_LABELS = {
  passed: { text: "pass", markdown: "✅ pass" },
  failed: { text: "FAIL", markdown: "❌ fail" },
};

function statusLabel(status, format) {
  return STATUS_LABELS[status]?.[format] ?? (format === "markdown" ? `⏭️ ${status}` : status);
}

function packageName(dir) {
  try {
    const { name } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (typeof name === "string") return name;
  } catch {
    // Fall through to the directory name.
  }
  return relative(REPO_ROOT, dir);
}

function formatMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value < 1 ? value.toFixed(3) : value.toFixed(2);
}

function firstLine(text) {
  return stripVTControlCharacters(String(text ?? ""))
    .trim()
    .split("\n")[0];
}

/**
 * @typedef {{ pkg: string, name: string, status: string, latency?: Record<string, number> }} Row
 * @returns {{ rows: Row[], failures: string[] }}
 */
function readResults(file) {
  const dir = dirname(file);
  const pkg = packageName(dir);
  const shown = relative(REPO_ROOT, file);
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      rows: [{ pkg, name: shown, status: "failed" }],
      failures: [`${shown}: unreadable (${error.message})`],
    };
  }

  const rows = [];
  const failures = [];
  for (const suite of report.testResults ?? []) {
    const suiteFile = suite.name ? relative(dir, suite.name) : shown;
    const tests = suite.assertionResults ?? [];
    if (tests.length === 0) {
      if (suite.status === "failed") {
        rows.push({ pkg, name: suiteFile, status: "failed" });
        failures.push(`${pkg} ${suiteFile}: ${firstLine(suite.message) || "suite failed"}`);
      }
      continue;
    }
    for (const test of tests) {
      if (test.status === "failed") {
        failures.push(
          `${pkg} › ${test.title}: ${firstLine(test.failureMessages?.[0]) || "failed"}`,
        );
      }
      const tasks = (test.benchmarks ?? []).flatMap((benchmark) => benchmark.tasks ?? []);
      if (tasks.length === 0) {
        rows.push({ pkg, name: test.title, status: test.status });
        continue;
      }
      for (const task of tasks) {
        const name = task.name === test.title ? test.title : `${test.title} › ${task.name}`;
        rows.push({ pkg, name, status: test.status, latency: task.latency });
      }
    }
  }
  if (report.success === false && failures.length === 0) {
    failures.push(`${shown}: Vitest reported a failed run`);
  }
  return { rows, failures };
}

function toCells(row, format) {
  return [
    row.pkg,
    row.name,
    formatMs(row.latency?.p50),
    formatMs(row.latency?.p99),
    row.latency?.samplesCount ?? "—",
    statusLabel(row.status, format),
  ];
}

function exitWithoutResults(message) {
  console.error(`✖ bench-check: ${message}`);
  writeStepSummary(`### Benchmarks\n\n❌ ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const searchRoots =
  args.length > 0
    ? args.map((dir) => resolve(dir))
    : DEFAULT_SEARCH_ROOTS.map((dir) => join(REPO_ROOT, dir));
const files = findFiles(searchRoots, RESULTS_FILE);
const multiplier = process.env.BENCH_BUDGET_MULTIPLIER || "1";

if (files.length === 0) {
  const roots = searchRoots.map((dir) => `${relative(REPO_ROOT, dir) || "."}/`).join(", ");
  exitWithoutResults(`no ${RESULTS_FILE} found under ${roots} — run \`pnpm bench\` first.`);
}

const rows = [];
const failures = [];
for (const file of files) {
  const result = readResults(file);
  rows.push(...result.rows);
  failures.push(...result.failures);
}
if (rows.length === 0 && failures.length === 0) {
  exitWithoutResults(
    `${files.length} ${RESULTS_FILE} file(s) found but they contain no benchmarks.`,
  );
}

console.log(`Benchmarks (BENCH_BUDGET_MULTIPLIER=${multiplier})\n`);
console.log(
  textTable(
    COLUMNS,
    rows.map((row) => toCells(row, "text")),
  ),
);

const summary = [
  "### Benchmarks",
  `Budgets are asserted in each \`*.bench.ts\`, scaled by \`BENCH_BUDGET_MULTIPLIER=${multiplier}\`.`,
  markdownTable(
    COLUMNS,
    rows.map((row) => toCells(row, "markdown")),
  ),
];
if (failures.length > 0) {
  summary.push(
    `**${failures.length} failure(s):**\n\n${failures.map((f) => `- ${f.replaceAll("\n", " ")}`).join("\n")}`,
  );
}
writeStepSummary(summary.join("\n\n"));

const packages = new Set(rows.map((row) => row.pkg)).size;
if (failures.length > 0) {
  console.error(`\n✖ bench-check: ${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`\n✔ bench-check: ${rows.length} benchmark(s) passed across ${packages} package(s).`);

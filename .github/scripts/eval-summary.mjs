#!/usr/bin/env node
/**
 * Renders agent eval results (`evals/eval-results/<mode>-<timestamp>.json`, written by `pnpm eval`
 * and `pnpm eval:mock`) as a table on the console and in the GitHub job summary. Reporting only:
 * the eval runner's exit code is the gate. Shows the newest results file per mode.
 *
 *   node .github/scripts/eval-summary.mjs [results-dir]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  annotate,
  markdownTable,
  REPO_ROOT,
  textTable,
  writeStepSummary,
} from "../../scripts/lib/report.mjs";

const MAX_FAILED_CASES = 25;
const dir = resolve(REPO_ROOT, process.argv[2] ?? "evals/eval-results");
const dirShown = relative(REPO_ROOT, dir);

const COLUMNS = [
  { header: "Suite" },
  { header: "Mode" },
  { header: "Cases", align: "right" },
  { header: "Critical failures", align: "right" },
  { header: "Metrics" },
  { header: "Thresholds" },
  { header: "Result" },
];

function formatValues(record) {
  return Object.entries(record ?? {})
    .map(([key, value]) => {
      const shown =
        typeof value === "number" && !Number.isInteger(value) ? value.toFixed(3) : value;
      return `${key}=${shown}`;
    })
    .join(" ");
}

function latestPerMode() {
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => join(dir, name))
    : [];
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const latest = new Map();
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      annotate(
        "warning",
        `${relative(REPO_ROOT, file)}: unreadable eval results (${error.message})`,
      );
      continue;
    }
    const mode = typeof data.mode === "string" ? data.mode : "unknown";
    if (!latest.has(mode)) latest.set(mode, { file, results: data.results ?? [] });
  }
  return latest;
}

function describeCase(testCase) {
  const expected = JSON.stringify(testCase.expected);
  const actual = JSON.stringify(testCase.actual);
  const notes = testCase.notes ? ` — ${testCase.notes}` : "";
  return `${testCase.critical ? "[critical] " : ""}${testCase.id}: expected ${expected}, got ${actual}${notes}`;
}

const latest = latestPerMode();
if (latest.size === 0) {
  const message = `No eval results found in ${dirShown}/.`;
  annotate("warning", message);
  writeStepSummary(`### Evals\n\n⚠️ ${message}`);
  process.exit(0);
}

for (const [mode, { file, results }] of latest) {
  const rows = results.map((suite) => {
    const cases = suite.cases ?? [];
    const passed = cases.filter((testCase) => testCase.passed).length;
    const critical = cases.filter((testCase) => !testCase.passed && testCase.critical).length;
    return {
      cells: [
        suite.suite,
        suite.mode ?? mode,
        `${passed}/${cases.length}`,
        critical,
        formatValues(suite.metrics),
        formatValues(suite.thresholds),
      ],
      passed: suite.passed === true,
    };
  });
  const failedCases = results.flatMap((suite) =>
    (suite.cases ?? [])
      .filter((testCase) => !testCase.passed)
      .map((testCase) => `${suite.suite} › ${describeCase(testCase)}`),
  );
  const shownFailures = failedCases.slice(0, MAX_FAILED_CASES);
  const more = failedCases.length - shownFailures.length;

  console.log(`\nEvals (${mode}): ${relative(REPO_ROOT, file)}\n`);
  console.log(
    textTable(
      COLUMNS,
      rows.map((row) => [...row.cells, row.passed ? "pass" : "FAIL"]),
    ),
  );
  if (shownFailures.length > 0) {
    console.log(`\nFailed cases (${failedCases.length}):`);
    for (const line of shownFailures) console.log(`  ${line}`);
    if (more > 0) console.log(`  … and ${more} more`);
  }

  const summary = [
    `### Evals (${mode})`,
    markdownTable(
      COLUMNS,
      rows.map((row) => [...row.cells, row.passed ? "✅ pass" : "❌ fail"]),
    ),
  ];
  if (shownFailures.length > 0) {
    const list = shownFailures.map((line) => `- ${line.replaceAll("\n", " ")}`).join("\n");
    summary.push(
      `<details><summary>Failed cases (${failedCases.length})</summary>\n\n${list}${more > 0 ? `\n- … and ${more} more` : ""}\n\n</details>`,
    );
  }
  writeStepSummary(summary.join("\n\n"));
}

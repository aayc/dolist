#!/usr/bin/env node
/**
 * Renders the Playwright perf results (`apps/web/perf-results.json`, written by `pnpm e2e:perf`) as
 * a table on the console and in the GitHub job summary. Reporting only: the perf specs assert their
 * budgets (scaled by PERF_BUDGET_MULTIPLIER) and fail the Playwright run themselves.
 *
 * Preferred shape: `{ "multiplier": 2, "results": [{ "name", "value", "unit"?, "budget"?, "passed"? }] }`.
 * Bare arrays of such records and objects keyed by metric name (`{ "tab:switch": { "p95": 12,
 * "budget": 30 } }`) are understood too; anything else is shown as raw JSON.
 *
 *   node .github/scripts/perf-summary.mjs [apps/web/perf-results.json]
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  annotate,
  markdownTable,
  REPO_ROOT,
  textTable,
  writeStepSummary,
} from "../../scripts/lib/report.mjs";

const LIST_KEYS = ["results", "metrics", "measurements", "measures"];
const NAME_KEYS = ["name", "metric", "id", "label"];
const VALUE_KEYS = ["value", "actual", "p95", "p50", "median", "mean", "duration", "ms"];
const BUDGET_KEYS = ["budget", "budgetMs", "limit", "threshold"];
const PASS_KEYS = ["passed", "pass", "ok", "withinBudget"];
const MULTIPLIER_KEYS = ["multiplier", "budgetMultiplier"];
const META_KEYS = new Set([
  ...MULTIPLIER_KEYS,
  "timestamp",
  "generatedAt",
  "createdAt",
  "date",
  "commit",
  "version",
  "browser",
  "mode",
]);
const RAW_JSON_LIMIT = 15_000;

const file = resolve(REPO_ROOT, process.argv[2] ?? "apps/web/perf-results.json");
const fileShown = relative(REPO_ROOT, file);

const COLUMNS = [
  { header: "Metric" },
  { header: "Value", align: "right" },
  { header: "Budget", align: "right" },
  { header: "Details" },
  { header: "Status" },
];

function pick(object, keys, type) {
  for (const key of keys) if (typeof object[key] === type) return object[key];
  return undefined;
}

function formatNumber(value) {
  if (Number.isInteger(value)) return String(value);
  return Math.abs(value) < 10 ? value.toFixed(2) : value.toFixed(1);
}

function normalize(value, fallbackName) {
  if (typeof value === "number") return { name: fallbackName, value, details: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const valueKey = VALUE_KEYS.find((key) => typeof value[key] === "number");
  if (!valueKey) return undefined;
  const status = typeof value.status === "string" ? value.status.toLowerCase() : undefined;
  const passed =
    pick(value, PASS_KEYS, "boolean") ??
    (status ? ["passed", "pass", "ok"].includes(status) : undefined);
  const shownKeys = new Set([valueKey, ...BUDGET_KEYS, ...PASS_KEYS]);
  const details = Object.entries(value)
    .filter(([key, v]) => typeof v === "number" && !shownKeys.has(key))
    .map(([key, v]) => `${key}=${formatNumber(v)}`);
  return {
    name: pick(value, NAME_KEYS, "string") ?? fallbackName,
    value: value[valueKey],
    valueKey,
    unit: typeof value.unit === "string" ? value.unit : undefined,
    budget: pick(value, BUDGET_KEYS, "number"),
    passed,
    details,
  };
}

function toRecords(data) {
  if (Array.isArray(data)) {
    return data.map((item, i) => normalize(item, `#${i + 1}`)).filter(Boolean);
  }
  if (!data || typeof data !== "object") return [];
  for (const key of LIST_KEYS) {
    if (data[key] && typeof data[key] === "object") return toRecords(data[key]);
  }
  return Object.entries(data)
    .filter(([key]) => !META_KEYS.has(key))
    .map(([key, value]) => normalize(value, key))
    .filter(Boolean);
}

function statusLabel(passed, markdown) {
  if (passed === undefined) return "—";
  if (passed) return markdown ? "✅ pass" : "pass";
  return markdown ? "❌ fail" : "FAIL";
}

function toCells(record, markdown) {
  const unit = record.unit ? ` ${record.unit}` : "";
  const stat = record.valueKey && !["value", "actual"].includes(record.valueKey);
  return [
    record.name,
    `${formatNumber(record.value)}${unit}${stat ? ` (${record.valueKey})` : ""}`,
    record.budget === undefined ? "—" : `${formatNumber(record.budget)}${unit}`,
    record.details.join(" "),
    statusLabel(record.passed, markdown),
  ];
}

if (!existsSync(file)) {
  const message = `${fileShown} not found — did the perf project run?`;
  annotate("warning", message);
  writeStepSummary(`### Perf (Playwright)\n\n⚠️ ${message}`);
  process.exit(0);
}

let data;
try {
  data = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  const message = `${fileShown} is not valid JSON (${error.message})`;
  annotate("warning", message);
  writeStepSummary(`### Perf (Playwright)\n\n⚠️ ${message}`);
  process.exit(0);
}

const multiplier =
  (data && typeof data === "object" && pick(data, MULTIPLIER_KEYS, "number")) ||
  process.env.PERF_BUDGET_MULTIPLIER ||
  1;
const records = toRecords(data);
const heading = `Perf (Playwright), PERF_BUDGET_MULTIPLIER=${multiplier}`;

if (records.length === 0) {
  const raw = JSON.stringify(data, null, 2);
  const shown = raw.length > RAW_JSON_LIMIT ? `${raw.slice(0, RAW_JSON_LIMIT)}\n…` : raw;
  console.log(`${heading}\n\n${shown}`);
  writeStepSummary(
    `### ${heading}\n\nUnrecognized results shape; raw \`${fileShown}\`:\n\n<details><summary>perf-results.json</summary>\n\n\`\`\`json\n${shown}\n\`\`\`\n\n</details>`,
  );
  process.exit(0);
}

console.log(`${heading}\n`);
console.log(
  textTable(
    COLUMNS,
    records.map((record) => toCells(record, false)),
  ),
);
writeStepSummary(
  [
    `### ${heading}`,
    markdownTable(
      COLUMNS,
      records.map((record) => toCells(record, true)),
    ),
  ].join("\n\n"),
);

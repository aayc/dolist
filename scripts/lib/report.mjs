/**
 * Helpers for repo tooling that reports results as tables: padded text for the terminal and
 * GitHub-flavored markdown for the Actions job summary (`$GITHUB_STEP_SUMMARY`).
 */
import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".turbo",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
]);

/** Recursively finds files named `fileName` under `roots`, skipping dependency and build dirs. */
export function findFiles(roots, fileName) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && entry.name === fileName) {
        found.push(path);
      }
    }
  };
  for (const root of roots) walk(root);
  return found.sort();
}

/**
 * @typedef {{ header: string, align?: "left" | "right" }} Column
 * @param {Column[]} columns
 * @param {Array<Array<string | number>>} rows
 */
export function textTable(columns, rows) {
  const cells = rows.map((row) => row.map(String));
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...cells.map((row) => row[i].length)),
  );
  const line = (row) =>
    row
      .map((cell, i) =>
        columns[i].align === "right" ? cell.padStart(widths[i]) : cell.padEnd(widths[i]),
      )
      .join("  ")
      .trimEnd();
  return [
    line(columns.map((column) => column.header)),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...cells.map(line),
  ].join("\n");
}

/**
 * @param {Column[]} columns
 * @param {Array<Array<string | number>>} rows
 */
export function markdownTable(columns, rows) {
  const line = (row) => `| ${row.map((cell) => escapeCell(String(cell))).join(" | ")} |`;
  return [
    line(columns.map((column) => column.header)),
    `| ${columns.map((column) => (column.align === "right" ? "---:" : ":---")).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
}

/** Escapes text so it renders literally inside a markdown table cell. */
export function escapeCell(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/g, "<br>");
}

/** Appends markdown to the GitHub Actions job summary. Returns false outside GitHub Actions. */
export function writeStepSummary(markdown) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: set by GitHub Actions; never read inside a Turbo task.
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return false;
  appendFileSync(file, `${markdown.trimEnd()}\n\n`);
  return true;
}

/** Prints a GitHub Actions annotation (`notice` | `warning` | `error`); plain text elsewhere. */
export function annotate(level, message) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: set by GitHub Actions; never read inside a Turbo task.
  if (process.env.GITHUB_ACTIONS === "true") {
    const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    console.log(`::${level}::${escaped}`);
  } else {
    console.log(`${level}: ${message}`);
  }
}

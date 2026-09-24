/**
 * Replays every vector against the Daily Do List editor in Chromium. Cases may only fail when
 * they are listed in `REPLAY_SKIPS` with the editor behavior that makes them differ.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright-core";
import { parseVectors } from "../format";
import type { ReplayRun } from "../pages/web";
import { REPLAY_SKIPS, skipReason } from "../upstream/expected-failures";
import { launchChromium, openScriptPage } from "./browser";
import { bundlePage } from "./bundle";
import { VECTORS_PATH } from "./vectors";

const CHUNK = 500;

export interface ReplayReport {
  total: number;
  passed: number;
  skipped: number;
  problems: string[];
}

export async function replayVectors(
  browser: Browser,
  text = readFileSync(VECTORS_PATH, "utf8"),
  filter = "",
): Promise<ReplayReport> {
  const cases = parseVectors(text).cases.filter((c) => c.name.startsWith(filter));
  const page = await openScriptPage(browser, await bundlePage("web.ts"));
  const total: ReplayRun = { passed: 0, mismatches: [], errors: [] };
  try {
    for (let i = 0; i < cases.length; i += CHUNK) {
      const run = await page.evaluate(
        (chunk) => window.__vimWeb.replay(chunk),
        cases.slice(i, i + CHUNK),
      );
      total.passed += run.passed;
      total.mismatches.push(...run.mismatches);
      total.errors.push(...run.errors);
    }
  } finally {
    await page.close();
  }
  const problems: string[] = [];
  let skipped = 0;
  const failing = new Set<string>();
  for (const mismatch of total.mismatches) {
    failing.add(mismatch.name);
    if (skipReason(mismatch.name)) {
      skipped++;
      continue;
    }
    problems.push(
      [
        `${mismatch.name} (step ${mismatch.step + 1}) differs in the Daily Do List editor`,
        ...differingFields(mismatch.expected, mismatch.actual),
      ].join("\n"),
    );
  }
  for (const { name, error } of total.errors) {
    failing.add(name);
    if (skipReason(name)) skipped++;
    else problems.push(`${name} throws in the Daily Do List editor:\n${error}`);
  }
  for (const pattern of filter ? [] : Object.keys(REPLAY_SKIPS)) {
    const matches = cases.filter(
      (c) => skipReason(c.name) !== undefined && matchesPattern(pattern, c.name),
    );
    if (matches.length === 0) problems.push(`replay skip ${pattern} matches no case`);
    else if (!matches.some((c) => failing.has(c.name))) {
      problems.push(`replay skip ${pattern} matches only passing cases; remove it`);
    }
  }
  return { total: cases.length, passed: total.passed, skipped, problems };
}

function differingFields(expected: unknown, actual: unknown): string[] {
  const a = (expected ?? {}) as Record<string, unknown>;
  const b = (actual ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    lines.push(`    ${key}: vector ${JSON.stringify(a[key])}, editor ${JSON.stringify(b[key])}`);
  }
  return lines;
}

function matchesPattern(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

async function main(): Promise<void> {
  const browser = await launchChromium();
  try {
    const started = performance.now();
    const filterAt = process.argv.indexOf("--filter");
    const filter = filterAt === -1 ? "" : (process.argv[filterAt + 1] ?? "");
    const report = await replayVectors(browser, undefined, filter);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `vector replay (Daily Do List editor): ${report.passed}/${report.total} identical, ` +
        `${report.skipped} skipped as known editor differences, in ${seconds}s`,
    );
    for (const problem of report.problems.slice(0, 60)) console.error(problem);
    if (report.problems.length > 60) console.error(`… and ${report.problems.length - 60} more`);
    if (report.problems.length > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
